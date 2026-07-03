/**
 * @fileoverview ProctorEngine.js — Production-Grade Quiz Proctoring System
 *
 * A memory-efficient, fully configurable proctoring engine with webcam management,
 * screen recording, face detection, chunked uploads, Supabase integration, retry
 * queues, Web Worker offloading, and seamless AntiCheatSystem integration.
 *
 * @author SmartLMS
 * @version 2.0.0
 * @license MIT
 */

(function (global) {
  'use strict';

  // ─────────────────────────────────────────────────────────────────────────────
  // Feature Detection
  // ─────────────────────────────────────────────────────────────────────────────

  const FEATURES = {
    getDisplayMedia: !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia),
    mediaRecorder: !!window.MediaRecorder,
    audioContext: !!(window.AudioContext || window.webkitAudioContext),
    workers: !!window.Worker,
    faceDetection: !!(window.FaceDetector || false),
    blobUrls: true,
    broadcastChannel: !!window.BroadcastChannel,
    intersectionObserver: !!window.IntersectionObserver,
    offscreenCanvas: typeof OffscreenCanvas !== 'undefined',
  };

  /**
   * @typedef {Object} ProctorConfig
   * @description All configuration options for ProctorEngine.
   */

  const DEFAULT_CONFIG = {
    webcam: {
      enabled: true,
      snapshotInterval: 15000,
      quality: 0.7,
      width: 1280,
      height: 720,
      audio: true,
      facingMode: 'user',
    },
    screen: {
      enabled: true,
      chunkDuration: 10000,
      mimeType: 'video/webm;codecs=vp9',
      audio: false,
      maxDuration: 0,
    },
    upload: {
      storageBucket: 'proctoring',
      storagePath: 'recordings',
      maxRetries: 5,
      retryDelay: 2000,
      maxConcurrent: 3,
      chunkUploadSize: 5 * 1024 * 1024,
      mimeTypes: ['image/jpeg', 'image/png', 'video/webm'],
    },
    database: {
      table: 'proctoring_logs',
      endpoint: '/rest/v1/proctoring_logs',
      headers: {},
    },
    faceDetection: {
      enabled: false,
      interval: 5000,
      minConfidence: 0.5,
      maxFaces: 1,
    },
    attemptId: null,
    userId: null,
    supabaseUrl: null,
    supabaseKey: null,
    callbacks: {},
    debug: false,
  };

  const MIME_PREFERENCES = [
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm',
    'video/mp4',
  ];

  // ─────────────────────────────────────────────────────────────────────────────
  // Utilities
  // ─────────────────────────────────────────────────────────────────────────────

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).substring(2, 9);
  }

  function getSupportedMimeType(candidates) {
    for (const mime of candidates) {
      if (MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(mime)) {
        return mime;
      }
    }
    return null;
  }

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function safeSerialize(obj) {
    const seen = new WeakSet();
    return JSON.stringify(obj, (key, value) => {
      if (typeof value === 'object' && value !== null) {
        if (seen.has(value)) return '[Circular]';
        seen.add(value);
      }
      if (value instanceof Blob) return `[Blob:${value.type}:${value.size}]`;
      if (value instanceof MediaStream) return '[MediaStream]';
      return value;
    });
  }

  class EventEmitter {
    constructor() {
      this._listeners = new Map();
    }
    on(event, handler) {
      if (!this._listeners.has(event)) this._listeners.set(event, []);
      this._listeners.get(event).push(handler);
      return () => this.off(event, handler);
    }
    once(event, handler) {
      const unsubscribe = this.on(event, (data) => {
        unsubscribe();
        handler(data);
      });
    }
    off(event, handler) {
      const handlers = this._listeners.get(event);
      if (!handlers) return;
      const idx = handlers.indexOf(handler);
      if (idx !== -1) handlers.splice(idx, 1);
    }
    emit(event, data) {
      const handlers = this._listeners.get(event);
      if (handlers) handlers.forEach(h => { try { h(data); } catch (e) { console.error(e); } });
      const wildcardHandlers = this._listeners.get('*');
      if (wildcardHandlers) {
        wildcardHandlers.forEach(h => {
          try { h({ type: event, data }); } catch (e) { console.error(e); }
        });
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Upload Worker
  // ─────────────────────────────────────────────────────────────────────────────

  function createInlineWorker(fn) {
    const blob = new Blob(
      ['(' + fn.toString() + ')(self)'],
      { type: 'application/javascript' }
    );
    return new Worker(URL.createObjectURL(blob));
  }

  function workerScript(self) {
    self.onmessage = function (e) {
      var msg = e.data;
      switch (msg.type) {
        case 'compress': {
          try {
            var canvas = new OffscreenCanvas(msg.width, msg.height);
            var ctx = canvas.getContext('2d');
            ctx.drawImage(msg.image, 0, 0);
            canvas.convertToBlob({ type: msg.mimeType || 'image/jpeg', quality: msg.quality || 0.7 })
              .then(function (blob) {
                self.postMessage({ id: msg.id, success: true, blob: blob }, [blob]);
              })
              .catch(function (err) { self.postMessage({ id: msg.id, success: false, error: err.message }); });
          } catch (err) {
            self.postMessage({ id: msg.id, success: false, error: err.message });
          }
          break;
        }
        case 'chunk': {
          try {
            var blob = msg.blob;
            var start = msg.start;
            var end = Math.min(start + msg.chunkSize, blob.size);
            var chunk = blob.slice(start, end);
            var reader = new FileReader();
            reader.onload = function () {
              self.postMessage({
                id: msg.id,
                success: true,
                chunk: reader.result,
                start: start,
                end: end,
                total: blob.size,
                index: msg.index,
                totalChunks: Math.ceil(blob.size / msg.chunkSize),
              });
            };
            reader.onerror = function () { self.postMessage({ id: msg.id, success: false, error: 'Read error' }); };
            reader.readAsDataURL(chunk);
          } catch (err) {
            self.postMessage({ id: msg.id, success: false, error: err.message });
          }
          break;
        }
        case 'ping':
          self.postMessage({ type: 'pong', id: msg.id });
          break;
      }
    };
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Retry Queue
  // ─────────────────────────────────────────────────────────────────────────────

  class RetryQueue {
    constructor(engine) {
      this.engine = engine;
      this.queue = [];
      this.activeIds = new Set();
      this.processingCount = 0;
      this.paused = false;
      this._timer = null;
    }
    add(item) {
      const id = uid();
      this.queue.push({ ...item, id, attempts: 0 });
      this.engine.emit('retry:queued', { id, type: item.type });
      this._schedule();
      return id;
    }
    _schedule() {
      if (this._timer || this.paused) return;
      this._timer = setTimeout(() => {
        this._timer = null;
        this.process();
      }, 1000);
    }
    async process() {
      if (this.paused || this.processingCount >= this.engine.config.upload.maxConcurrent) return;
      const item = this.queue.find(i => !this.activeIds.has(i.id));
      if (!item) return;

      this.activeIds.add(item.id);
      this.processingCount++;
      item.attempts++;
      item.lastAttempt = Date.now();

      try {
        const result = await this._upload(item);
        this.activeIds.delete(item.id);
        this.processingCount--;

        if (result.success) {
          this.queue = this.queue.filter(i => i.id !== item.id);
          this.engine.emit('retry:success', { id: item.id, type: item.type, path: result.path });
        } else {
          item.error = result.error;
          if (item.attempts >= this.engine.config.upload.maxRetries) {
            this.engine.emit('retry:exhausted', { id: item.id, type: item.type, error: result.error });
            this.queue = this.queue.filter(i => i.id !== item.id);
          } else {
            this.engine.emit('retry:retrying', { id: item.id, type: item.type, attempt: item.attempts, error: result.error });
          }
        }
      } catch (err) {
        this.activeIds.delete(item.id);
        this.processingCount--;
        item.error = err.message;
      }
      this._schedule();
    }
    async _upload(item) {
      const baseDelay = this.engine.config.upload.retryDelay;
      const backoff = Math.min(baseDelay * Math.pow(2, item.attempts - 1), 60000);
      await delay(backoff);
      switch (item.type) {
        case 'snapshot': return this.engine._doSnapshotUpload(item.path, item.data, item.meta);
        case 'chunk': return this.engine._doChunkUpload(item.path, item.data, item.meta);
        case 'log': return this.engine._doLogUpload(item.data);
        default: return { success: false, error: `Unknown type: ${item.type}`, attempts: item.attempts };
      }
    }
    getStatus() {
      return { pending: this.queue.length, active: this.activeIds.size, total: this.queue.length };
    }
    pause() {
      this.paused = true;
      if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    }
    resume() {
      this.paused = false;
      this._schedule();
    }
    clear() {
      this.queue = [];
      this.activeIds.clear();
      if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Face Detector
  // ─────────────────────────────────────────────────────────────────────────────

  class FaceDetector {
    constructor(engine) {
      this.engine = engine;
      this._timer = null;
      this._running = false;
      this.detector = null;
    }
    async init() {
      if (!this.engine.config.faceDetection.enabled) return false;
      if ('FaceDetector' in window) {
        try {
          this.detector = new window.FaceDetector({ fastMode: true, maxDetectedFaces: this.engine.config.faceDetection.maxFaces + 1 });
          this.engine.debug('FaceDetector: Using native API');
          return true;
        } catch (e) {
          this.engine.debug('FaceDetector: Native API failed, falling back');
        }
      }
      this.engine.debug('FaceDetector: Using canvas-based fallback');
      return true;
    }
    async detect(video) {
      if (!this._running) return { count: 0, faces: [], confidence: 0 };
      if (this.detector && typeof this.detector.detect === 'function') {
        try {
          const faces = await this.detector.detect(video);
          return {
            count: faces.length,
            faces: faces.map(f => ({ boundingBox: f.boundingBox, landmarks: f.landmarks })),
            confidence: Math.min(1, faces.length / this.engine.config.faceDetection.maxFaces),
          };
        } catch (e) {
          return { count: 0, faces: [], confidence: 0, error: e.message };
        }
      }
      return this._canvasFallback(video);
    }
    _canvasFallback(video) {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = 80;
        canvas.height = 60;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(video, 0, 0, 80, 60);
        const imageData = ctx.getImageData(0, 0, 80, 60);
        let totalBrightness = 0;
        let pixelCount = 0;
        for (let i = 0; i < imageData.data.length; i += 4) {
          totalBrightness += (imageData.data[i] + imageData.data[i + 1] + imageData.data[i + 2]) / 3;
          pixelCount++;
        }
        const avgBrightness = totalBrightness / pixelCount;
        let variance = 0;
        for (let i = 0; i < imageData.data.length; i += 4) {
          const b = (imageData.data[i] + imageData.data[i + 1] + imageData.data[i + 2]) / 3;
          variance += Math.pow(b - avgBrightness, 2);
        }
        variance = Math.sqrt(variance / pixelCount);
        const confidence = clamp(variance / 50, 0, 1);
        const estimatedFaces = confidence > 0.3 ? 1 : 0;
        return { count: estimatedFaces, faces: [], confidence };
      } catch (e) {
        return { count: 0, faces: [], confidence: 0, error: e.message };
      }
    }
    start(video) {
      if (!this.engine.config.faceDetection.enabled) return;
      this._running = true;
      this._tick(video);
    }
    stop() {
      this._running = false;
      if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    }
    async _tick(video) {
      if (!this._running) return;
      try {
        const result = await this.detect(video);
        const cfg = this.engine.config.faceDetection;
        if (result.count > cfg.maxFaces) {
          this.engine.emit('violation', { source: 'face', type: 'MULTIPLE_FACES', severity: 'HIGH', data: { count: result.count, maxFaces: cfg.maxFaces } });
        } else if (result.count === 0 && result.confidence < 0.1) {
          this.engine.emit('face:none', { confidence: result.confidence });
        }
        this.engine.emit('face:detected', result);
      } catch (e) { this.engine.debug('FaceDetector tick error: ' + e.message); }
      this._timer = setTimeout(() => this._tick(video), this.engine.config.faceDetection.interval);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Main Engine
  // ─────────────────────────────────────────────────────────────────────────────

  class ProctorEngine extends EventEmitter {
    constructor(config = {}) {
      super();
      this.config = this._mergeConfig(DEFAULT_CONFIG, config);
      if (!this.config.attemptId) throw new Error('ProctorEngine: attemptId is required');
      if (!this.config.userId) throw new Error('ProctorEngine: userId is required');
      this.state = {
        isActive: false,
        startTime: null,
        webcamStream: null,
        screenStream: null,
        mediaRecorder: null,
        recordingChunks: [],
        snapshotIndex: 0,
        chunkIndex: 0,
        totalSnapshotSize: 0,
        totalChunkSize: 0,
        sessionId: uid(),
        deviceInfo: this._getDeviceInfo(),
        networkStatus: navigator.onLine,
        reconnectAttempts: 0,
      };
      this._snapshotTimer = null;
      this._worker = null;
      this._workerPending = new Map();
      this.retryQueue = new RetryQueue(this);
      this.faceDetector = new FaceDetector(this);
      this._sb = null;
      this._webcamVideo = null;
    }

    async start({ webcamElement } = {}) {
      if (this.state.isActive) return;
      this._checkBrowserSupport();
      this.state.isActive = true;
      this.state.startTime = Date.now();
      this.emit('session:starting', { attemptId: this.config.attemptId });
      try {
        await this._initSupabase();
        this._initWorker();
        if (this.config.webcam.enabled) await this._startWebcam(webcamElement);
        if (this.config.screen.enabled) await this._startScreenRecording();
        if (this.config.faceDetection.enabled) {
          await this.faceDetector.init();
          if (this._webcamVideo) this.faceDetector.start(this._webcamVideo);
        }
        this._startSnapshots();
        this._startConnectionMonitor();
        await this._logEvent('SESSION_STARTED', { sessionId: this.state.sessionId, attemptId: this.config.attemptId, userId: this.config.userId, device: this.state.deviceInfo });
        this._notifyAntiCheat('SESSION_STARTED');
        this.emit('session:started', { attemptId: this.config.attemptId, sessionId: this.state.sessionId });
      } catch (err) {
        this.state.isActive = false;
        this._cleanup();
        this.emit('session:error', { error: err.message });
        throw err;
      }
    }

    async stop({ saveLogs = true, waitForUploads = false } = {}) {
      if (!this.state.isActive) return null;
      this.state.isActive = false;
      const duration = Date.now() - (this.state.startTime || Date.now());
      this.emit('session:stopping', { duration });
      this._stopSnapshots();
      this.faceDetector.stop();
      await this._finalizeScreenRecording();
      this._stopStreams();
      this._destroyWorker();
      if (waitForUploads) await this._drainRetryQueue();
      await this._logEvent('SESSION_ENDED', { sessionId: this.state.sessionId, duration, snapshots: this.state.snapshotIndex, chunks: this.state.chunkIndex });
      this._notifyAntiCheat('SESSION_ENDED');
      const stats = { duration, snapshots: this.state.snapshotIndex, chunks: this.state.chunkIndex, sessionId: this.state.sessionId };
      if (saveLogs) this._saveLocalLogs(stats);
      this.emit('session:stopped', stats);
      return stats;
    }

    async captureSnapshot() { await this._captureAndUploadSnapshot(); }
    getStats() { return { ...this.state, elapsed: this.state.startTime ? Date.now() - this.state.startTime : 0 }; }

    async injectViolation(violation) {
      const event = {
        sessionId: this.state.sessionId,
        attemptId: this.config.attemptId,
        user_id: this.config.userId,
        type: violation.type || 'CUSTOM_VIOLATION',
        source: violation.source || 'integration',
        severity: violation.severity || 'LOW',
        elapsed: Date.now() - (this.state.startTime || Date.now()),
        timestamp: new Date().toISOString(),
        data: violation.data || violation,
      };
      await this._logEvent('VIOLATION', event);
      this.emit('violation', event);
      if (this.config.callbacks.onViolation) this.config.callbacks.onViolation(event);
    }

    // ── Webcam ─────────────────────────────────────────────────────────────
    async _startWebcam(existingElement) {
      const cfg = this.config.webcam;
      const constraints = {
        video: { width: { ideal: cfg.width }, height: { ideal: cfg.height }, facingMode: cfg.facingMode },
        audio: cfg.audio ? { echoCancellation: true, noiseSuppression: true } : false,
      };
      try {
        this.state.webcamStream = await navigator.mediaDevices.getUserMedia(constraints);
      } catch (err) {
        if (cfg.audio) {
          constraints.audio = false;
          this.state.webcamStream = await navigator.mediaDevices.getUserMedia(constraints);
        } else throw err;
      }
      this._webcamVideo = existingElement || this._createWebcamElement();
      this._webcamVideo.srcObject = this.state.webcamStream;
      await this._waitForVideo(this._webcamVideo);
      this.emit('webcam:started', {});
    }
    _createWebcamElement() {
      const v = document.createElement('video');
      v.autoplay = v.muted = v.playsInline = true;
      v.style.cssText = 'position:absolute;width:1px;height:1px;opacity:0;pointer-events:none;';
      document.body.appendChild(v);
      return v;
    }
    _waitForVideo(v) {
      return new Promise((res, rej) => {
        if (v.videoWidth) return res();
        const t = setTimeout(() => rej(new Error('Video timeout')), 5000);
        v.onloadedmetadata = () => { clearTimeout(t); res(); };
      });
    }

    // ── Screen ─────────────────────────────────────────────────────────────
    async _startScreenRecording() {
      if (!FEATURES.getDisplayMedia) throw new Error('No getDisplayMedia');
      try {
        this.state.screenStream = await navigator.mediaDevices.getDisplayMedia({ video: { displaySurface: 'monitor' }, audio: this.config.screen.audio });
      } catch (e) { return; }
      const mime = getSupportedMimeType(MIME_PREFERENCES) || this.config.screen.mimeType;
      this.state.mediaRecorder = new MediaRecorder(this.state.screenStream, { mimeType: mime });
      this.state.mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) this._handleRecordingChunk(e.data); };
      this.state.mediaRecorder.start(this.config.screen.chunkDuration);
      this.state.screenStream.getVideoTracks()[0].onended = () => this._finalizeScreenRecording();
      this.emit('screen:started', {});
    }
    async _handleRecordingChunk(blob) {
      const idx = this.state.chunkIndex++;
      const meta = { sessionId: this.state.sessionId, attemptId: this.config.attemptId, userId: this.config.userId, chunkIndex: idx, size: blob.size, timestamp: new Date().toISOString() };
      this.state.totalChunkSize += blob.size;
      const path = this._storagePath(`chunks/${this.state.sessionId}/chunk-${idx}.webm`);

      if (blob.size > this.config.upload.chunkUploadSize) {
          await this._chunkedBlobUpload(blob, path, 'chunk', meta);
      } else {
          await this._uploadBlob(blob, path, 'chunk', meta);
      }
      this.emit('chunk:recorded', meta);
    }
    async _finalizeScreenRecording() {
      if (this.state.mediaRecorder?.state !== 'inactive') this.state.mediaRecorder?.stop();
      this.state.screenStream?.getTracks().forEach(t => t.stop());
      this.state.screenStream = null;
    }

    // ── Snapshots ──────────────────────────────────────────────────────────
    _startSnapshots() {
      if (!this._webcamVideo) return;
      this._captureAndUploadSnapshot();
      this._snapshotTimer = setInterval(() => this._captureAndUploadSnapshot(), this.config.webcam.snapshotInterval);
    }
    _stopSnapshots() { clearInterval(this._snapshotTimer); }
    async _captureAndUploadSnapshot() {
      if (!this._webcamVideo?.videoWidth) return;
      const idx = this.state.snapshotIndex++;
      try {
        const blob = await this._compressSnapshot(this._webcamVideo);
        this.state.totalSnapshotSize += blob.size;
        const meta = { sessionId: this.state.sessionId, attemptId: this.config.attemptId, userId: this.config.userId, snapshotIndex: idx, timestamp: new Date().toISOString() };
        await this._uploadBlob(blob, this._storagePath(`snapshots/${this.state.sessionId}/snap-${idx}.jpg`), 'snapshot', meta);
      } catch (e) {
          this.emit('snapshot:error', { index: idx, error: e.message });
      }
    }
    async _compressSnapshot(video) {
      const { quality, width, height } = this.config.webcam;
      const vw = width || video.videoWidth;
      const vh = height || video.videoHeight;

      if (this._worker && FEATURES.offscreenCanvas) {
          return this._compressInWorker(video, vw, vh, quality);
      }

      const canvas = document.createElement('canvas');
      canvas.width = vw; canvas.height = vh;
      canvas.getContext('2d').drawImage(video, 0, 0, vw, vh);
      return new Promise(res => canvas.toBlob(res, 'image/jpeg', quality));
    }

    _compressInWorker(video, width, height, quality) {
        return new Promise((resolve, reject) => {
            const id = uid();
            const handler = (e) => {
                if (e.data.id !== id) return;
                this._worker.removeEventListener('message', handler);
                if (e.data.success) resolve(e.data.blob);
                else reject(new Error(e.data.error || 'Worker compression failed'));
            };
            this._worker.addEventListener('message', handler);
            createImageBitmap(video).then(bitmap => {
                this._worker.postMessage({ id, type: 'compress', image: bitmap, width, height, quality }, [bitmap]);
            }).catch(e => {
                this._worker.removeEventListener('message', handler);
                reject(e);
            });
        });
    }

    // ── Data ───────────────────────────────────────────────────────────────

    async _performRawUpload(blob, path) {
        if (!this._sb) return { data: null, error: { message: 'Supabase not initialized' } };
        return this._sb.storage.from(this.config.upload.storageBucket).upload(path, blob, { upsert: true, contentType: blob.type });
    }

    async _performRawLog(record) {
        if (!this._sb) return { error: { message: 'Supabase not initialized' } };
        return this._sb.from(this.config.database.table).insert(record);
    }

    async _uploadBlob(blob, path, type, meta = {}) {
      const { data, error } = await this._performRawUpload(blob, path);
      if (error) {
        this.retryQueue.add({ type, data: blob, path, meta });
        return { success: false, error: error.message, attempts: 1 };
      }

      if (type === 'snapshot' || type === 'chunk') {
          await this._logEvent(type, meta);
      }

      this.emit('upload:success', { type, path });
      return { success: true, path };
    }

    async _chunkedBlobUpload(blob, path, type, metadata) {
      const chunkSize = this.config.upload.chunkUploadSize;
      const totalChunks = Math.ceil(blob.size / chunkSize);
      for (let i = 0; i < totalChunks; i++) {
        const start = i * chunkSize;
        const end = Math.min(start + chunkSize, blob.size);
        const chunkBlob = blob.slice(start, end);
        const chunkPath = path + `.part-${i}`;
        const res = await this._uploadBlob(chunkBlob, chunkPath, type, { ...metadata, partIndex: i });
        if (!res.success) return res;
      }
      return { success: true, path, chunks: totalChunks };
    }

    async _logEvent(type, data) {
      const record = {
          session_id: this.state.sessionId,
          attempt_id: this.config.attemptId,
          user_id: this.config.userId,
          event_type: type,
          event_data: data,
          elapsed: Date.now() - (this.state.startTime || Date.now()),
          device: this.state.deviceInfo,
          timestamp: new Date().toISOString()
      };
      const { error } = await this._performRawLog(record);
      if (error) {
        this.retryQueue.add({ type: 'log', data: record });
        this.emit('log:error', { type, error: error.message });
      } else {
        this.emit('log:success', { type });
      }
    }

    async _doSnapshotUpload(path, blob, meta) {
        const { error } = await this._performRawUpload(blob, path);
        if (error) return { success: false, error: error.message, attempts: 1 };
        await this._performRawLog({
            session_id: this.state.sessionId,
            attempt_id: this.config.attemptId,
            user_id: this.config.userId,
            event_type: 'snapshot',
            event_data: meta,
            elapsed: Date.now() - (this.state.startTime || Date.now()),
            device: this.state.deviceInfo,
            timestamp: new Date().toISOString()
        });
        return { success: true, path };
    }

    async _doChunkUpload(path, blob, meta) {
        const { error } = await this._performRawUpload(blob, path);
        if (error) return { success: false, error: error.message, attempts: 1 };
        await this._performRawLog({
            session_id: this.state.sessionId,
            attempt_id: this.config.attemptId,
            user_id: this.config.userId,
            event_type: 'chunk',
            event_data: meta,
            elapsed: Date.now() - (this.state.startTime || Date.now()),
            device: this.state.deviceInfo,
            timestamp: new Date().toISOString()
        });
        return { success: true, path };
    }

    async _doLogUpload(record) {
        const { error } = await this._performRawLog(record);
        if (error) return { success: false, error: error.message, attempts: 1 };
        return { success: true };
    }

    async _initSupabase() {
      if (!this.config.supabaseUrl || !this.config.supabaseKey) return;
      if (window.supabase) {
        this._sb = window.supabase.createClient(this.config.supabaseUrl, this.config.supabaseKey);
      } else {
        this._sb = {
            storage: {
                from: (bucket) => ({
                    upload: async (path, blob, opts = {}) => {
                        const res = await fetch(`${this.config.supabaseUrl}/storage/v1/object/${bucket}/${path}`, {
                            method: 'POST',
                            headers: { 'Authorization': `Bearer ${this.config.supabaseKey}`, 'x-upsert': opts.upsert ? 'true' : 'false', 'Content-Type': opts.contentType || blob.type },
                            body: blob
                        });
                        if (!res.ok) return { data: null, error: { message: 'REST Upload Failed' } };
                        return { data: { path }, error: null };
                    },
                    getPublicUrl: (path) => ({ publicUrl: `${this.config.supabaseUrl}/storage/v1/object/public/${bucket}/${path}` })
                })
            },
            from: (table) => ({
                insert: async (record) => {
                    const res = await fetch(`${this.config.supabaseUrl}/rest/v1/${table}`, {
                        method: 'POST',
                        headers: { 'Authorization': `Bearer ${this.config.supabaseKey}`, 'apikey': this.config.supabaseKey, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
                        body: JSON.stringify(record)
                    });
                    if (!res.ok) return { data: null, error: { message: 'REST Insert Failed' } };
                    return { data: record, error: null };
                }
            })
        };
      }
    }

    _storagePath(rel) { return `${this.config.upload.storagePath}/${this.config.userId}/${this.config.attemptId}/${rel}`; }

    _startConnectionMonitor() {
      window.addEventListener('online', () => { this.state.networkStatus = true; this.retryQueue.resume(); });
      window.addEventListener('offline', () => { this.state.networkStatus = false; this.retryQueue.pause(); });
    }
    _stopConnectionMonitor() {}

    _notifyAntiCheat(event) {
      if (!window.AntiCheat) return;
      if (event === 'SESSION_STARTED') {
        window.AntiCheat.init(this.config.attemptId, 'quiz', this.config.userId, {
          BLOCK_TAB_SWITCH: true,
          callbacks: { onViolation: (v) => this.injectViolation(v) }
        });
      }
    }

    _cleanup() {
      this._stopSnapshots();
      this.state.webcamStream?.getTracks().forEach(t => t.stop());
      this.state.screenStream?.getTracks().forEach(t => t.stop());
      this._destroyWorker();
    }

    _initWorker() {
        if (!FEATURES.workers) return;
        try {
            this._worker = createInlineWorker(workerScript);
            this._worker.onmessage = (e) => {
                if (e.data.type === 'pong') return;
                const pending = this._workerPending.get(e.data.id);
                if (pending) { pending(e.data); this._workerPending.delete(e.data.id); }
            };
        } catch (e) { this.debug('Worker init failed', e); }
    }
    _destroyWorker() { if (this._worker) { this._worker.terminate(); this._worker = null; } }

    _saveLocalLogs(stats) {
        try {
            const logs = { engine: 'ProctorEngine', sessionId: this.state.sessionId, attemptId: this.config.attemptId, userId: this.config.userId, stats, deviceInfo: this.state.deviceInfo };
            const blob = new Blob([safeSerialize(logs)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `proctor-log-${this.state.sessionId}.json`;
            if (this.config.debug) a.click();
            URL.revokeObjectURL(url);
        } catch (e) {}
    }

    _checkBrowserSupport() {
        const missing = [];
        if (!FEATURES.getDisplayMedia) missing.push('getDisplayMedia');
        if (!navigator.mediaDevices?.getUserMedia) missing.push('getUserMedia');
        if (missing.length > 0) throw new Error('Missing features: ' + missing.join(', '));
    }

    _getDeviceInfo() {
        return {
            browser: navigator.userAgent,
            os: navigator.userAgentData?.platform || navigator.platform || 'Unknown',
            screen: { w: screen.width, h: screen.height },
            memory: navigator.deviceMemory,
            cores: navigator.hardwareConcurrency,
            lang: navigator.language,
            online: navigator.onLine
        };
    }

    _mergeConfig(b, u) {
      const r = { ...b };
      for (const k in u) {
        if (typeof u[k] === 'object' && u[k] !== null && !Array.isArray(u[k])) r[k] = this._mergeConfig(b[k] || {}, u[k]);
        else r[k] = u[k];
      }
      return r;
    }
    debug(...a) { if (this.config.debug) console.debug('[Proctor]', ...a); }
    async _drainRetryQueue() {
        const start = Date.now();
        while (this.retryQueue.getStatus().pending > 0 && Date.now() - start < 30000) await delay(1000);
    }
  }

  global.ProctorEngine = ProctorEngine;
})(window);
