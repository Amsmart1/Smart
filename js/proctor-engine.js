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
 *
 * @example
 * const proctor = new ProctorEngine({
 *   supabaseUrl: 'https://xxx.supabase.co',
 *   supabaseKey: 'your-anon-key',
 *   attemptId: 'quiz-123',
 *   userId: 'user-456',
 *
 *   webcam: { snapshotInterval: 15000, quality: 0.7 },
 *   screen: { chunkDuration: 10000, mimeType: 'video/webm;codecs=vp9' },
 *   upload: { maxRetries: 5, chunkSize: 1024 * 1024 },
 *
 *   callbacks: {
 *     onViolation: (v) => AntiCheat.logViolation(v.type, v),
 *     onFaceDetected: (faces) => console.log('Faces:', faces),
 *   }
 * });
 *
 * await proctor.start();
 * // ... quiz in progress ...
 * await proctor.stop();
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
    faceDetection: !!window.FaceDetector,
    blobUrls: true,
    broadcastChannel: !!window.BroadcastChannel,
    intersectionObserver: !!window.IntersectionObserver,
  };

  /**
   * @typedef {Object} ProctorConfig
   * @description All configuration options for ProctorEngine.
   */

  /**
   * @typedef {Object} WebcamConfig
   * @property {boolean} [enabled=true] - Enable webcam capture
   * @property {number} [snapshotInterval=15000] - Interval between snapshots (ms)
   * @property {number} [quality=0.7] - JPEG quality for snapshots (0–1)
   * @property {number} [width=1280] - Preferred webcam resolution width
   * @property {number} [height=720] - Preferred webcam resolution height
   * @property {boolean} [audio=true] - Capture audio from webcam
   * @property {string} [facingMode='user'] - 'user' (front) or 'environment' (back)
   */

  /**
   * @typedef {Object} ScreenConfig
   * @property {boolean} [enabled=true] - Enable screen recording
   * @property {number} [chunkDuration=10000] - Chunk duration in ms
   * @property {string} [mimeType='video/webm;codecs=vp9'] - Recording codec
   * @property {boolean} [audio=false] - Capture system audio (not widely supported)
   * @property {number} [maxDuration=0] - Max recording duration (0 = unlimited)
   */

  /**
   * @typedef {Object} UploadConfig
   * @property {string} [storageBucket='proctoring'] - Supabase storage bucket name
   * @property {string} [storagePath='recordings'] - Path prefix in storage
   * @property {number} [maxRetries=5] - Max retry attempts per upload
   * @property {number} [retryDelay=2000] - Initial retry delay (ms), doubles each retry
   * @property {number} [maxConcurrent=3] - Max concurrent uploads
   * @property {number} [chunkUploadSize=5 * 1024 * 1024] - Chunk size for large files (5MB)
   * @property {string[]} [mimeTypes=['image/jpeg','image/png','video/webm']] - Allowed MIME types
   */

  /**
   * @typedef {Object} DatabaseConfig
   * @property {string} [table='violations'] - Database table name
   * @property {string} [endpoint='/rest/v1/violations'] - REST endpoint path
   * @property {Object} [headers={}] - Additional headers for database requests
   */

  /**
   * @typedef {Object} FaceDetectionConfig
   * @property {boolean} [enabled=false] - Enable face detection
   * @property {number} [interval=5000] - Face detection check interval (ms)
   * @property {number} [minConfidence=0.5] - Minimum confidence threshold (0–1)
   * @property {number} [maxFaces=1] - Maximum expected faces (alerts if exceeded)
   */

  /**
   * @typedef {Object} NoiseDetectionConfig
   * @property {boolean} [enabled=false] - Enable noise detection
   * @property {number} [threshold=-50] - Noise threshold in decibels (RMS)
   * @property {number} [minDuration=1000] - Minimum duration of noise to trigger violation (ms)
   */

  /**
   * @typedef {Object} RetryQueueItem
   * @property {string} id - Unique queue item ID
   * @property {'snapshot'|'chunk'|'log'|'blob'} type - Upload type
   * @property {Blob|string} data - Payload to upload
   * @property {string} path - Supabase storage path
   * @property {number} attempts - Current attempt count
   * @property {number} [lastAttempt] - Timestamp of last attempt
   * @property {string} [error] - Last error message
   */

  /**
   * @typedef {'LOW'|'MEDIUM'|'HIGH'|'CRITICAL'} ViolationSeverity
   * @typedef {'webcam'|'screen'|'upload'|'face'|'system'|'network'} ViolationSource
   */

  /**
   * @typedef {Object} ProctorEvent
   * @property {string} type - Event type identifier
   * @property {Object} [data] - Event payload
   * @property {string} timestamp - ISO 8601 timestamp
   * @property {number} elapsed - Milliseconds since session start
   */

  /**
   * @typedef {Object} UploadResult
   * @property {boolean} success - Whether upload succeeded
   * @property {string} [path] - Storage path on success
   * @property {string} [url] - Public URL on success
   * @property {string} [error] - Error message on failure
   * @property {number} attempts - Number of attempts made
   */

  // ─────────────────────────────────────────────────────────────────────────────
  // Constants
  // ─────────────────────────────────────────────────────────────────────────────

  const DEFAULT_CONFIG = {
    /** @type {WebcamConfig} */
    webcam: {
      enabled: true,
      snapshotInterval: 15000,
      quality: 0.7,
      width: 1280,
      height: 720,
      audio: true,
      facingMode: 'user',
    },
    /** @type {ScreenConfig} */
    screen: {
      enabled: true,
      chunkDuration: 10000,
      mimeType: 'video/webm;codecs=vp9',
      audio: false,
      maxDuration: 0,
    },
    /** @type {UploadConfig} */
    upload: {
      storageBucket: 'proctoring',
      storagePath: 'recordings',
      maxRetries: 5,
      retryDelay: 2000,
      maxConcurrent: 3,
      chunkUploadSize: 5 * 1024 * 1024,
      mimeTypes: ['image/jpeg', 'image/png', 'video/webm'],
    },
    /** @type {DatabaseConfig} */
    database: {
      table: 'violations',
      endpoint: '/rest/v1/violations',
      headers: {},
    },
    /** @type {FaceDetectionConfig} */
    faceDetection: {
      enabled: false,
      interval: 5000,
      minConfidence: 0.5,
      maxFaces: 1,
    },
    /** @type {NoiseDetectionConfig} */
    noiseDetection: {
      enabled: false,
      threshold: -50,
      minDuration: 1000,
    },
    /** @type {AudioConfig} */
    audio: {
      enabled: false,
      chunkDuration: 15000,
      mimeType: 'audio/webm',
    },
    /** @type {string} */
    sessionId: null,
    /** @type {string} */
    attemptId: null,
    /** @type {string} */
    courseId: null,
    /** @type {string} */
    userId: null,
    /** @type {string|null} */
    supabaseUrl: null,
    /** @type {string|null} */
    supabaseKey: null,
    /** @type {Object} */
    callbacks: {},
    /** @type {boolean} */
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

  /**
   * Generates a compact unique ID without external dependencies.
   * @returns {string}
   */
  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).substring(2, 9);
  }

  /**
   * Gets the best supported MIME type from a preference list.
   * @param {string[]} candidates
   * @returns {string|null}
   */
  function getSupportedMimeType(candidates) {
    for (const mime of candidates) {
      if (MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(mime)) {
        return mime;
      }
    }
    return null;
  }

  /**
   * Clamps a value between min and max.
   * @param {number} value
   * @param {number} min
   * @param {number} max
   * @returns {number}
   */
  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  /**
   * Delays execution for a given number of milliseconds.
   * @param {number} ms
   * @returns {Promise<void>}
   */
  function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Serializes an object to JSON, handling circular references.
   * @param {Object} obj
   * @returns {string}
   */
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

  /**
   * Simple event emitter with wildcard support.
   */
  class EventEmitter {
    constructor() {
      /** @type {Map<string, Function[]>} */
      this._listeners = new Map();
    }

    /**
     * Subscribe to an event.
     * @param {string} event
     * @param {Function} handler
     * @returns {Function} Unsubscribe function
     */
    on(event, handler) {
      if (!this._listeners.has(event)) this._listeners.set(event, []);
      this._listeners.get(event).push(handler);
      return () => this.off(event, handler);
    }

    /**
     * Subscribe to an event once.
     * @param {string} event
     * @param {Function} handler
     */
    once(event, handler) {
      const unsubscribe = this.on(event, (data) => {
        unsubscribe();
        handler(data);
      });
    }

    /**
     * Unsubscribe from an event.
     * @param {string} event
     * @param {Function} handler
     */
    off(event, handler) {
      const handlers = this._listeners.get(event);
      if (!handlers) return;
      const idx = handlers.indexOf(handler);
      if (idx !== -1) handlers.splice(idx, 1);
    }

    /**
     * Emit an event to all subscribers.
     * @param {string} event
     * @param {*} data
     */
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
  // Upload Worker (inline as blob URL — no separate file needed)
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Creates a Web Worker from an inline function as a Blob.
   * Handles compression and chunked uploads off the main thread.
   * @param {Function} fn - Worker function
   * @returns {Worker}
   */
  function createInlineWorker(fn) {
    const blob = new Blob(
      ['(' + fn.toString() + ')(self)'],
      { type: 'application/javascript' }
    );
    return new Worker(URL.createObjectURL(blob));
  }

  /**
   * Worker script — runs in a separate thread.
   * Handles JPEG compression, file chunking, and base64 encoding.
   */
  // prettier-ignore
  function workerScript(self) {
    self.onmessage = function (e) {
      var msg = e.data;
      switch (msg.type) {
        case 'compress': {
          try {
            var canvas = new OffscreenCanvas(msg.width || msg.image.width, msg.height || msg.image.height);
            var ctx = canvas.getContext('2d');
            ctx.drawImage(msg.image, 0, 0);
            canvas.convertToBlob({ type: msg.mimeType || 'image/jpeg', quality: msg.quality || 0.7 })
              .then(function (blob) { self.postMessage({ id: msg.id, success: true, blob: blob }, [blob]); })
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

  /**
   * Manages a persistent queue of failed uploads with exponential backoff.
   * Automatically processes the queue when network conditions improve.
   */
  class RetryQueue {
    /**
     * @param {ProctorEngine} engine
     */
    constructor(engine) {
      /** @type {ProctorEngine} */
      this.engine = engine;
      /** @type {RetryQueueItem[]} */
      this.queue = [];
      /** @type {Set<string>} */
      this.activeIds = new Set();
      /** @type {number} */
      this.processingCount = 0;
      /** @type {boolean} */
      this.paused = false;
      /** @type {number} */
      this._timer = null;
    }

    /**
     * Add an item to the retry queue.
     * @param {Omit<RetryQueueItem, 'id'|'attempts'|'lastAttempt'|'error'>} item
     * @returns {string} Queue item ID
     */
    add(item) {
      const id = uid();
      this.queue.push({ ...item, id, attempts: 0 });
      this.engine.emit('retry:queued', { id, type: item.type });
      this._schedule();
      return id;
    }

    /**
     * Schedule queue processing.
     * @private
     */
    _schedule() {
      if (this._timer || this.paused) return;
      this._timer = setTimeout(() => {
        this._timer = null;
        this.process();
      }, 1000);
    }

    /**
     * Process the retry queue, honoring max concurrent limit.
     * @returns {Promise<void>}
     */
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
          // Remove from queue
          this.queue = this.queue.filter(i => i.id !== item.id);
          this.engine.emit('retry:success', { id: item.id, type: item.type, path: result.path });
        } else {
          item.error = result.error;
          if (item.attempts >= this.engine.config.upload.maxRetries) {
            this.engine.emit('retry:exhausted', { id: item.id, type: item.type, error: result.error });
            this.queue = this.queue.filter(i => i.id !== item.id);
          } else {
            this.engine.emit('retry:retrying', {
              id: item.id,
              type: item.type,
              attempt: item.attempts,
              error: result.error,
            });
          }
        }
      } catch (err) {
        this.activeIds.delete(item.id);
        this.processingCount--;
        item.error = err.message;
      }

      this._schedule();
    }

    /**
     * Upload a single queue item with exponential backoff delay.
     * @param {RetryQueueItem} item
     * @returns {Promise<UploadResult>}
     */
    async _upload(item) {
      const baseDelay = this.engine.config.upload.retryDelay;
      const backoff = Math.min(baseDelay * Math.pow(2, item.attempts - 1), 60000);

      await delay(backoff);

      switch (item.type) {
        case 'snapshot':
          return this.engine._doSnapshotUpload(item.path, item.data);
        case 'chunk':
          return this.engine._doChunkUpload(item.path, item.data);
        case 'log':
          return this.engine._doLogUpload(item.path, item.data);
        default:
          return { success: false, error: `Unknown type: ${item.type}`, attempts: item.attempts };
      }
    }

    /**
     * Get current queue status.
     * @returns {{ pending: number, active: number, total: number }}
     */
    getStatus() {
      return {
        pending: this.queue.length,
        active: this.activeIds.size,
        total: this.queue.length,
      };
    }

    /**
     * Pause queue processing.
     */
    pause() {
      this.paused = true;
      if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    }

    /**
     * Resume queue processing.
     */
    resume() {
      this.paused = false;
      this._schedule();
    }

    /**
     * Clear all queued items.
     */
    clear() {
      this.queue = [];
      this.activeIds.clear();
      if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Face Detector
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Abstract face detection interface.
   * Uses native FaceDetector API if available, otherwise uses canvas-based fallback.
   */
  class FaceDetector {
    /**
     * @param {ProctorEngine} engine
     */
    constructor(engine) {
      /** @type {ProctorEngine} */
      this.engine = engine;
      /** @type {number|null} */
      this._timer = null;
      /** @type {boolean} */
      this._running = false;
      /** @type {Object|null} */
      this.detector = null;
    }

    /**
     * Initialize the face detector (platform-specific).
     * @returns {Promise<boolean>} Whether face detection is available
     */
    async init() {
      if (!this.engine.config.faceDetection.enabled) return false;

      // Try native FaceDetector API
      if ('FaceDetector' in window) {
        try {
          this.detector = new window.FaceDetector({
            fastMode: true,
            maxDetectedFaces: this.engine.config.faceDetection.maxFaces + 1,
          });
          this.engine.debug('FaceDetector: Using native API');
          return true;
        } catch (e) {
          this.engine.debug('FaceDetector: Native API failed, falling back');
        }
      }

      // Fallback: naive motion/canvas detection
      // For production, you'd integrate face-api.js or TensorFlow.js here
      this.engine.debug('FaceDetector: Using canvas-based fallback');
      return true;
    }

    /**
     * Detect faces in a video element.
     * @param {HTMLVideoElement} video
     * @returns {Promise<{count: number, faces: Array, confidence: number}>}
     */
    async detect(video) {
      if (!this._running) return { count: 0, faces: [], confidence: 0 };

      if (this.detector && typeof this.detector.detect === 'function') {
        try {
          const faces = await this.detector.detect(video);
          return {
            count: faces.length,
            faces: faces.map(f => ({
              boundingBox: f.boundingBox,
              landmarks: f.landmarks,
            })),
            confidence: Math.min(1, faces.length / this.engine.config.faceDetection.maxFaces),
          };
        } catch (e) {
          return { count: 0, faces: [], confidence: 0, error: e.message };
        }
      }

      // Fallback: check if video has meaningful pixel data
      // This is a basic heuristic — real implementation should use ML
      return this._canvasFallback(video);
    }

    /**
     * Canvas-based fallback face detection using pixel variance.
     * @private
     * @param {HTMLVideoElement} video
     * @returns {{count: number, faces: Array, confidence: number}}
     */
    _canvasFallback(video) {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = 80;
        canvas.height = 60;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(video, 0, 0, 80, 60);
        const imageData = ctx.getImageData(0, 0, 80, 60);

        // Simple variance-based detection
        let totalBrightness = 0;
        let pixelCount = 0;
        for (let i = 0; i < imageData.data.length; i += 4) {
          totalBrightness += (imageData.data[i] + imageData.data[i + 1] + imageData.data[i + 2]) / 3;
          pixelCount++;
        }
        const avgBrightness = totalBrightness / pixelCount;

        // Estimate presence based on brightness variance
        let variance = 0;
        for (let i = 0; i < imageData.data.length; i += 4) {
          const b = (imageData.data[i] + imageData.data[i + 1] + imageData.data[i + 2]) / 3;
          variance += Math.pow(b - avgBrightness, 2);
        }
        variance = Math.sqrt(variance / pixelCount);

        // Heuristic: meaningful variance suggests face presence
        const confidence = clamp(variance / 50, 0, 1);
        const estimatedFaces = confidence > 0.3 ? 1 : 0;

        return { count: estimatedFaces, faces: [], confidence };
      } catch (e) {
        return { count: 0, faces: [], confidence: 0, error: e.message };
      }
    }

    /**
     * Start periodic face detection.
     * @param {HTMLVideoElement} video
     */
    start(video) {
      if (!this.engine.config.faceDetection.enabled) return;
      this._running = true;
      this._tick(video);
    }

    /**
     * Stop face detection.
     */
    stop() {
      this._running = false;
      if (this._timer) { clearTimeout(this._timer); this._timer = null; }
      this.detector = null;
    }

    /**
     * Detection tick.
     * @private
     */
    async _tick(video) {
      if (!this._running) return;

      try {
        const result = await this.detect(video);
        const cfg = this.engine.config.faceDetection;

        if (result.count > cfg.maxFaces) {
          await this.engine._reportEvent('MULTIPLE_FACES', {
            source: 'face',
            severity: 'HIGH',
            score: 3,
            count: result.count,
            maxFaces: cfg.maxFaces,
            confidence: result.confidence
          });
        } else if (result.count === 0 && result.confidence < 0.1) {
          this.engine.emit('face:none', { confidence: result.confidence });
        }

        this.engine.emit('face:detected', result);

        // Log face detection event for stats
        await this.engine._reportEvent('FACE_DETECTED', {
            count: result.count,
            confidence: result.confidence,
            timestamp: new Date().toISOString()
        });
      } catch (e) {
        this.engine.debug('FaceDetector tick error: ' + e.message);
      }

      this._timer = setTimeout(() => this._tick(video), this.engine.config.faceDetection.interval);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Main Engine
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * NoiseDetector class.
   * Monitors real-time audio levels and detects persistent noise violations.
   */
  class NoiseDetector {
    /**
     * @param {ProctorEngine} engine
     */
    constructor(engine) {
      /** @type {ProctorEngine} */
      this.engine = engine;
      /** @type {AudioContext|null} */
      this.audioCtx = null;
      /** @type {AnalyserNode|null} */
      this.analyser = null;
      /** @type {MediaStreamAudioSourceNode|null} */
      this.source = null;
      /** @type {number|null} */
      this._timer = null;
      /** @type {boolean} */
      this._running = false;
      /** @type {number} */
      this._noiseStartTime = null;
    }

    /**
     * Initialize the noise detector.
     * @param {MediaStream} stream - The audio stream to monitor
     * @returns {boolean}
     */
    init(stream) {
      if (!this.engine.config.noiseDetection.enabled || !FEATURES.audioContext) return false;
      if (!stream || stream.getAudioTracks().length === 0) return false;

      try {
        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        this.audioCtx = new AudioContextClass();
        this.analyser = this.audioCtx.createAnalyser();
        this.analyser.fftSize = 2048;
        this.source = this.audioCtx.createMediaStreamSource(stream);
        this.source.connect(this.analyser);
        this.engine.debug('NoiseDetector: Initialized');
        return true;
      } catch (e) {
        this.engine.debug('NoiseDetector: Initialization failed', e);
        return false;
      }
    }

    /**
     * Start monitoring audio levels.
     */
    start() {
      if (!this.analyser) return;
      this._running = true;
      this._noiseStartTime = null;
      this._tick();
    }

    /**
     * Stop monitoring audio levels.
     */
    stop() {
      this._running = false;
      if (this._timer) { cancelAnimationFrame(this._timer); this._timer = null; }
      if (this.audioCtx && this.audioCtx.state !== 'closed') {
        this.audioCtx.close().catch(() => {});
      }
      this.audioCtx = null;
      this.analyser = null;
      this.source = null;
    }

    /**
     * Monitoring tick.
     * @private
     */
    async _tick() {
      if (!this._running) return;

      const bufferLength = this.analyser.frequencyBinCount;
      const dataArray = new Float32Array(bufferLength);
      this.analyser.getFloatTimeDomainData(dataArray);

      // Calculate RMS (Root Mean Square) for volume level
      let sum = 0;
      for (let i = 0; i < bufferLength; i++) {
        sum += dataArray[i] * dataArray[i];
      }
      const rms = Math.sqrt(sum / bufferLength);
      const db = 20 * Math.log10(rms || 1e-6); // Avoid log(0)

      const cfg = this.engine.config.noiseDetection;
      if (db > cfg.threshold) {
        if (!this._noiseStartTime) {
          this._noiseStartTime = Date.now();
        } else if (Date.now() - this._noiseStartTime > cfg.minDuration) {
          // Persistent noise detected
          const noiseData = { db: Math.round(db), threshold: cfg.threshold, duration: Date.now() - this._noiseStartTime };

          // Log violation via standardized reporting pipeline
          await this.engine._reportEvent('NOISE_DETECTED', {
            ...noiseData,
            source: 'proctor',
            severity: 'MEDIUM',
            score: 2
          });

          this._noiseStartTime = Date.now(); // Reset to avoid continuous spamming, or handle cooldown
        }
      } else {
        this._noiseStartTime = null;
      }

      this._timer = requestAnimationFrame(() => this._tick());
    }
  }

  /**
   * Main ProctorEngine class.
   *
   * @example
   * const proctor = new ProctorEngine({
   *   supabaseUrl: 'https://xxx.supabase.co',
   *   supabaseKey: 'eyJ...',
   *   attemptId: 'quiz-001',
   *   userId: 'user-123',
   *   webcam: { snapshotInterval: 15000 },
   *   screen: { enabled: true, chunkDuration: 10000 },
   *   callbacks: {
   *     onViolation: (v) => AntiCheat.logViolation(v.type, v),
   *     onUpload: (u) => console.log('Uploaded:', u),
   *   }
   * });
   * await proctor.start();
   */
  class ProctorEngine extends EventEmitter {
    /**
     * Creates a new ProctorEngine instance.
     *
     * @param {Partial<ProctorConfig>} [config={}] - Configuration object
     * @throws {Error} If attemptId or userId is not provided
     */
    constructor(config = {}) {
      super();

      /** @type {ProctorConfig} */
      this.config = this._mergeConfig(DEFAULT_CONFIG, config);

      if (!this.config.attemptId) throw new Error('ProctorEngine: attemptId is required');
      if (!this.config.userId) throw new Error('ProctorEngine: userId is required');

      // ── State ──────────────────────────────────────────────────────────────
      this.state = {
        isActive: false,
        startTime: null,
        webcamStream: null,
        screenStream: null,
        audioRecorder: null,
        mediaRecorder: null,
        recordingChunks: [],
        snapshotIndex: 0,
        chunkIndex: 0,
        audioChunkIndex: 0,
        totalSnapshotSize: 0,
        totalChunkSize: 0,
        totalAudioSize: 0,
        sessionId: this.config.sessionId || uid(),
        deviceInfo: window.DeviceUtils ? window.DeviceUtils.getFullContext() : this._getDeviceInfo(),
        networkStatus: navigator.onLine,
        reconnectAttempts: 0,
      };

      // ── Timers ─────────────────────────────────────────────────────────────
      this._snapshotTimer = null;
      this._connectionCheckTimer = null;
      this._reconnectTimer = null;

      // ── Upload Worker ──────────────────────────────────────────────────────
      /** @type {Worker|null} */
      this._worker = null;
      this._workerPending = new Map();

      // ── Subsystems ─────────────────────────────────────────────────────────
      /** @type {RetryQueue} */
      this.retryQueue = new RetryQueue(this);

      /** @type {FaceDetector} */
      this.faceDetector = new FaceDetector(this);

      /** @type {NoiseDetector} */
      this.noiseDetector = new NoiseDetector(this);

      // ── Supabase REST client (no external deps) ─────────────────────────────
      /** @type {Object|null} */
      this._sb = null;

      // ── Webcam video element (created lazily) ───────────────────────────────
      /** @type {HTMLVideoElement|null} */
      this._webcamVideo = null;

      this.debug('ProctorEngine: Instantiated', {
        attemptId: this.config.attemptId,
        userId: this.config.userId,
        features: FEATURES,
      });
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Public API
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Starts the proctoring session.
     * Initializes webcam, screen recording, face detection, and upload pipeline.
     *
     * @param {Object} [options]
     * @param {HTMLVideoElement} [options.webcamElement] - Existing video element for webcam
     * @returns {Promise<void>}
     * @throws {Error} If permissions are denied or browser unsupported
     */
    async start({ webcamElement } = {}) {
      if (this.state.isActive) {
        this.debug('start() called but already active — ignoring');
        return;
      }

      this._checkBrowserSupport();

      this.state.isActive = true;
      this.state.startTime = Date.now();

      this.emit('session:starting', { attemptId: this.config.attemptId });

      try {
        // Initialize Supabase client
        await this._initSupabase();

        // Initialize upload worker
        this._initWorker();

        // Start webcam
        if (this.config.webcam.enabled) {
          await this._startWebcam(webcamElement);
        }

        // Start screen recording
        if (this.config.screen.enabled) {
          await this._startScreenRecording();
        }

        // Start audio recording
        if (this.config.audio.enabled) {
          await this._startAudioRecording();
        }

        // Initialize face detection
        if (this.config.faceDetection.enabled) {
          await this.faceDetector.init();
          if (this._webcamVideo) {
            this.faceDetector.start(this._webcamVideo);
          }
        }

        // Initialize noise detection
        if (this.config.noiseDetection.enabled && this.state.webcamStream) {
          if (this.noiseDetector.init(this.state.webcamStream)) {
            this.noiseDetector.start();
          }
        }

        // Start periodic snapshots
        this._startSnapshots();

        // Start connection monitoring
        this._startConnectionMonitor();

        // Log session start
        await this._reportEvent('SESSION_STARTED', {
          config: {
            webcam: this.config.webcam,
            screen: this.config.screen,
            faceDetection: this.config.faceDetection,
          },
        });

        this.emit('session:started', {
          attemptId: this.config.attemptId,
          sessionId: this.state.sessionId,
        });

        this.debug('ProctorEngine: Session started', { sessionId: this.state.sessionId });
      } catch (err) {
        this.state.isActive = false;
        this._cleanup();
        this.emit('session:error', { error: err.message, code: err.code });
        throw err;
      }
    }

    /**
     * Stops the proctoring session gracefully.
     * Stops all streams, finalizes recordings, processes the retry queue,
     * clears resources, and returns session metadata.
     *
     * @param {Object} [options]
     * @param {boolean} [options.saveLogs=true] - Whether to save logs to file
     * @param {boolean} [options.waitForUploads=true] - Wait for retry queue to drain
     * @returns {Promise<{duration: number, snapshots: number, chunks: number, stats: Object}>}
     */
    async stop({ saveLogs = true, waitForUploads = false } = {}) {
      if (!this.state.isActive) {
        this.debug('stop() called but not active — ignoring');
        return null;
      }

      this.state.isActive = false;
      const endTime = Date.now();
      const duration = endTime - (this.state.startTime || endTime);

      this.emit('session:stopping', { duration });

      // Stop all subsystems
      this._stopSnapshots();
      this.faceDetector.stop();
      this.noiseDetector.stop();
      this._stopConnectionMonitor();

      // Finalize screen recording
      await this._finalizeScreenRecording();

      // Finalize audio recording
      await this._finalizeAudioRecording();

      // Stop streams
      this._stopStreams();

      // Cleanup worker
      this._destroyWorker();

      // Process retry queue
      if (waitForUploads) {
        await this._drainRetryQueue();
      }

      // Log session end
      await this._reportEvent('SESSION_ENDED', {
        duration,
        snapshotsUploaded: this.state.snapshotIndex,
        chunksRecorded: this.state.chunkIndex,
        audioChunksRecorded: this.state.audioChunkIndex,
        totalSnapshotSize: this.state.totalSnapshotSize,
        totalChunkSize: this.state.totalChunkSize,
        totalAudioSize: this.state.totalAudioSize,
      });

      const stats = {
        duration,
        snapshots: this.state.snapshotIndex,
        chunks: this.state.chunkIndex,
        audioChunks: this.state.audioChunkIndex,
        totalSnapshotSize: this.state.totalSnapshotSize,
        totalChunkSize: this.state.totalChunkSize,
        totalAudioSize: this.state.totalAudioSize,
        retryQueue: this.retryQueue.getStatus(),
        sessionId: this.state.sessionId,
      };

      if (saveLogs) {
        this._saveLocalLogs(stats);
      }

      this.emit('session:stopped', stats);
      this.debug('ProctorEngine: Session stopped', stats);

      return stats;
    }

    /**
     * Manually trigger a snapshot capture and upload.
     * @returns {Promise<void>}
     */
    async captureSnapshot() {
      await this._captureAndUploadSnapshot();
    }

    /**
     * Get current session stats.
     * @returns {Object}
     */
    getStats() {
      const elapsed = this.state.startTime ? Date.now() - this.state.startTime : 0;
      return {
        isActive: this.state.isActive,
        elapsed,
        snapshots: this.state.snapshotIndex,
        chunks: this.state.chunkIndex,
        audioChunks: this.state.audioChunkIndex,
        totalSnapshotSize: this.state.totalSnapshotSize,
        totalChunkSize: this.state.totalChunkSize,
        totalAudioSize: this.state.totalAudioSize,
        sessionId: this.state.sessionId,
        retryQueue: this.retryQueue.getStatus(),
        networkStatus: this.state.networkStatus,
      };
    }

    /**
     * Check if a specific feature is supported in the current browser.
     * @param {keyof typeof FEATURES} feature
     * @returns {boolean}
     */
    isSupported(feature) {
      return !!FEATURES[feature];
    }

    /**
     * Get all feature support status.
     * @returns {Object}
     */
    getSupportedFeatures() {
      return { ...FEATURES };
    }

    /**
     * Dynamically update configuration while session is running.
     * Only non-critical options can be updated mid-session.
     *
     * @param {Partial<ProctorConfig>} updates
     */
    updateConfig(updates) {
      this.config = this._mergeConfig(this.config, updates);
      this.emit('config:updated', updates);
      this.debug('Config updated', updates);
    }

    /**
     * Manually trigger a reconnection attempt.
     * @returns {Promise<boolean>}
     */
    async reconnect() {
      if (!this._sb) return false;

      this.emit('network:reconnecting', { attempt: this.state.reconnectAttempts + 1 });

      try {
        // Re-authenticate with Supabase
        await this._initSupabase();
        this.state.networkStatus = navigator.onLine;
        this.state.reconnectAttempts = 0;
        this.retryQueue.resume();
        this.emit('network:reconnected', {});
        return true;
      } catch (e) {
        this.emit('network:reconnect_failed', { error: e.message });
        return false;
      }
    }

    /**
     * Inject a custom violation/event (e.g., from AntiCheatSystem integration).
     *
     * @param {Object} violation
     * @returns {Promise<void>}
     */
    async injectViolation(violation) {
      await this._reportEvent(violation.type || 'CUSTOM_VIOLATION', {
          source: violation.source || 'proctor',
          severity: violation.severity || 'LOW',
          score: violation.score || 1,
          data: violation.data || violation
      });
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Webcam Management
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Starts the webcam stream.
     * @private
     * @param {HTMLVideoElement} [existingElement]
     */
    async _startWebcam(existingElement) {
      const cfg = this.config.webcam;

      const constraints = {
        video: {
          width: { ideal: cfg.width },
          height: { ideal: cfg.height },
          facingMode: cfg.facingMode,
        },
        audio: cfg.audio ? {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        } : false,
      };

      try {
        this.state.webcamStream = await navigator.mediaDevices.getUserMedia(constraints);
      } catch (err) {
        // Try video-only if audio fails
        if (cfg.audio && (err.name === 'NotAllowedError' || err.name === 'NotFoundError')) {
          this.debug('Audio access denied, falling back to video-only');
          constraints.audio = false;
          this.state.webcamStream = await navigator.mediaDevices.getUserMedia(constraints);
        } else {
          throw err;
        }
      }

      // Attach to video element
      this._webcamVideo = existingElement || this._createWebcamElement();
      this._webcamVideo.srcObject = this.state.webcamStream;

      // Handle track ended (e.g., camera physically disconnected)
      this.state.webcamStream.getVideoTracks().forEach(track => {
        track.onended = () => {
          this.emit('webcam:ended', { reason: 'track_ended' });
          this.debug('Webcam track ended');
        };
      });

      // Wait for video to be ready
      await this._waitForVideo(this._webcamVideo);

      this.emit('webcam:started', {
        width: this._webcamVideo.videoWidth,
        height: this._webcamVideo.videoHeight,
      });

      this.debug('Webcam started', {
        width: this._webcamVideo.videoWidth,
        height: this._webcamVideo.videoHeight,
      });
    }

    /**
     * Creates a hidden video element for webcam capture.
     * @private
     * @returns {HTMLVideoElement}
     */
    _createWebcamElement() {
      const video = document.createElement('video');
      video.autoplay = true;
      video.muted = true;
      video.playsInline = true;
      video.style.cssText = 'position:absolute;width:1px;height:1px;opacity:0;pointer-events:none;';
      document.body.appendChild(video);
      return video;
    }

    /**
     * Waits for a video element to have valid dimensions.
     * @private
     * @param {HTMLVideoElement} video
     * @param {number} [timeout=5000]
     * @returns {Promise<void>}
     */
    _waitForVideo(video, timeout = 5000) {
      return new Promise((resolve, reject) => {
        if (video.videoWidth && video.videoHeight) { resolve(); return; }

        const timer = setTimeout(() => {
          video.removeEventListener('loadedmetadata', onLoad);
          reject(new Error('Video stream timeout'));
        }, timeout);

        const onLoad = () => {
          clearTimeout(timer);
          resolve();
        };

        video.addEventListener('loadedmetadata', onLoad, { once: true });
      });
    }

    /**
     * Switches the active webcam device (if multiple cameras available).
     * @param {string} [deviceId]
     * @returns {Promise<void>}
     */
    async switchCamera(deviceId) {
      if (!this.state.webcamStream) throw new Error('No active webcam stream');

      const constraints = {
        video: deviceId ? { deviceId: { exact: deviceId } } : true,
        audio: false,
      };

      const oldTrack = this.state.webcamStream.getVideoTracks()[0];
      const newStream = await navigator.mediaDevices.getUserMedia(constraints);
      const newTrack = newStream.getVideoTracks()[0];

      // Replace track in existing stream
      oldTrack.stop();
      const audioTrack = this.state.webcamStream.getAudioTracks()[0];
      this.state.webcamStream = new MediaStream([
        newTrack,
        ...(audioTrack ? [audioTrack] : []),
      ]);

      if (this._webcamVideo) {
        this._webcamVideo.srcObject = this.state.webcamStream;
        await this._waitForVideo(this._webcamVideo);
      }

      this.emit('webcam:switched', { deviceId: newTrack.getSettings().deviceId });
      await this._reportEvent('WEBCAM_SWITCHED', { deviceId });
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Screen Recording
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Starts screen recording with chunked capture.
     * @private
     */
    async _startScreenRecording() {
      if (!FEATURES.getDisplayMedia) {
        this.emit('screen:unsupported', {});
        throw new Error('Screen recording not supported in this browser');
      }

      const cfg = this.config.screen;

      const constraints = {
        video: {
          displaySurface: 'monitor',
        },
        audio: cfg.audio,
      };

      try {
        this.state.screenStream = await navigator.mediaDevices.getDisplayMedia(constraints);
      } catch (err) {
        if (err.name === 'NotAllowedError') {
          this.emit('screen:denied', {});
          this.debug('Screen recording permission denied');
          // Don't throw — screen sharing is optional
          return;
        }
        throw err;
      }

      // Determine supported MIME type
      const mimeType = getSupportedMimeType(MIME_PREFERENCES) || cfg.mimeType;
      this.debug('Using MIME type: ' + mimeType);

      // Create MediaRecorder
      const options = { mimeType };
      try {
        this.state.mediaRecorder = new MediaRecorder(this.state.screenStream, options);
      } catch (e) {
        // Fallback MIME type
        this.state.mediaRecorder = new MediaRecorder(this.state.screenStream);
      }

      this.state.recordingChunks = [];

      this.state.mediaRecorder.ondataavailable = (e) => {
        if (!e.data || e.data.size === 0) return;
        this._handleRecordingChunk(e.data);
      };

      this.state.mediaRecorder.onstop = () => {
        this.debug('MediaRecorder stopped');
      };

      // Handle user stopping share via browser UI
      const videoTrack = this.state.screenStream.getVideoTracks()[0];
      videoTrack.onended = () => {
        this.emit('screen:ended', { reason: 'user_stopped' });
        this.debug('Screen share ended by user');
        this._reportEvent('SCREEN_SHARE_STOPPED', {
            reason: 'user_stopped',
            severity: 'HIGH',
            score: 5
        });
        this._finalizeScreenRecording();
      };

      // Start recording with time-slice chunks
      this.state.mediaRecorder.start(this.config.screen.chunkDuration);

      // Enforce max duration if set
      if (cfg.maxDuration > 0) {
        setTimeout(() => {
          if (this.state.isActive) {
            this._finalizeScreenRecording();
            this.emit('screen:max_duration_reached', {});
          }
        }, cfg.maxDuration);
      }

      this.emit('screen:started', {
        maxDuration: cfg.maxDuration,
        chunkDuration: cfg.chunkDuration,
      });

      await this._reportEvent('SCREEN_RECORDING_STARTED', {
        mimeType: this.state.mediaRecorder.mimeType,
        chunkDuration: cfg.chunkDuration,
      });
    }

    /**
     * Handles a single recording chunk from MediaRecorder.
     * @private
     * @param {Blob} blob
     */
    async _handleRecordingChunk(blob) {
      const chunkIndex = this.state.chunkIndex++;
      const timestamp = new Date().toISOString();
      const size = blob.size;

      this.state.totalChunkSize += size;
      const path = this._storagePath(`chunks/${this.state.sessionId}/chunk-${chunkIndex}.webm`);

      const metadata = {
        sessionId: this.state.sessionId,
        attemptId: this.config.attemptId,
        user_email: this.config.userId,
        chunkIndex,
        timestamp,
        size,
        mimeType: blob.type || 'video/webm',
        elapsed: Date.now() - (this.state.startTime || Date.now()),
        path: path
      };

      // Log chunk recorded
      await this._reportEvent('CHUNK_RECORDED', {
        chunkIndex,
        timestamp,
        size,
        path: path
      });

      // Upload chunk (potentially chunked for large files)
      this._uploadRecordingChunk(blob, path, metadata);

      this.emit('chunk:recorded', metadata);

      this.debug('Recording chunk ' + chunkIndex, { size, total: this.state.totalChunkSize });
    }

    /**
     * Uploads a recording chunk, possibly splitting large blobs.
     * @private
     * @param {Blob} blob
     * @param {string} path
     * @param {Object} metadata
     */
    async _uploadRecordingChunk(blob, path, metadata) {
      if (blob.size > this.config.upload.chunkUploadSize) {
        // Large file: chunk and upload in parallel
        this.debug('Large chunk detected, using chunked upload: ' + blob.size + ' bytes');
        await this._chunkedBlobUpload(blob, path, 'chunk', metadata);
      } else {
        // Normal upload via Supabase
        await this._uploadBlob(blob, path, 'chunk', metadata);
      }
    }

    /**
     * Finalizes the current screen recording.
     * @private
     */
    async _finalizeScreenRecording() {
      if (!this.state.mediaRecorder) return;

      if (this.state.mediaRecorder.state !== 'inactive') {
        this.state.mediaRecorder.stop();
      }

      if (this.state.screenStream) {
        this.state.screenStream.getTracks().forEach(track => track.stop());
        this.state.screenStream = null;
      }

      this.emit('screen:finalized', {
        totalChunks: this.state.chunkIndex,
        totalSize: this.state.totalChunkSize,
      });

      await this._reportEvent('SCREEN_RECORDING_FINALIZED', {
        totalChunks: this.state.chunkIndex,
        totalSize: this.state.totalChunkSize,
      });
    }

    /**
     * Starts audio recording in chunks.
     * @private
     */
    async _startAudioRecording() {
      if (!this.state.webcamStream || this.state.webcamStream.getAudioTracks().length === 0) {
        this.debug('Audio recording skipped: no audio tracks available');
        return;
      }

      const cfg = this.config.audio;
      const options = { mimeType: cfg.mimeType };

      try {
        this.state.audioRecorder = new MediaRecorder(this.state.webcamStream, options);
      } catch (e) {
        this.state.audioRecorder = new MediaRecorder(this.state.webcamStream);
      }

      this.state.audioRecorder.ondataavailable = (e) => {
        if (!e.data || e.data.size === 0) return;
        this._handleAudioChunk(e.data);
      };

      this.state.audioRecorder.start(cfg.chunkDuration);

      this.emit('audio:started', {
        chunkDuration: cfg.chunkDuration,
      });

      await this._reportEvent('AUDIO_RECORDING_STARTED', {
        mimeType: this.state.audioRecorder.mimeType,
        chunkDuration: cfg.chunkDuration,
      });
    }

    /**
     * Handles a single audio chunk from MediaRecorder.
     * @private
     * @param {Blob} blob
     */
    async _handleAudioChunk(blob) {
      const chunkIndex = this.state.audioChunkIndex++;
      const timestamp = new Date().toISOString();
      const size = blob.size;

      this.state.totalAudioSize += size;
      const path = this._storagePath(`audio/${this.state.sessionId}/chunk-${chunkIndex}.webm`);

      const metadata = {
        sessionId: this.state.sessionId,
        attemptId: this.config.attemptId,
        user_email: this.config.userId,
        chunkIndex,
        timestamp,
        size,
        mimeType: blob.type || 'audio/webm',
        elapsed: Date.now() - (this.state.startTime || Date.now()),
        path: path
      };

      await this._reportEvent('AUDIO_RECORDED', {
        chunkIndex,
        timestamp,
        size,
        path: path
      });

      await this._uploadBlob(blob, path, 'chunk', metadata);

      this.emit('audio:recorded', metadata);
      this.debug('Audio chunk ' + chunkIndex, { size, total: this.state.totalAudioSize });
    }

    /**
     * Finalizes the current audio recording.
     * @private
     */
    async _finalizeAudioRecording() {
      if (!this.state.audioRecorder) return;

      if (this.state.audioRecorder.state !== 'inactive') {
        this.state.audioRecorder.stop();
      }

      this.emit('audio:finalized', {
        totalChunks: this.state.audioChunkIndex,
        totalSize: this.state.totalAudioSize,
      });

      await this._reportEvent('AUDIO_RECORDING_FINALIZED', {
        totalChunks: this.state.audioChunkIndex,
        totalSize: this.state.totalAudioSize,
      });
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Snapshots
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Starts the periodic snapshot capture.
     * @private
     */
    _startSnapshots() {
      if (!this._webcamVideo) return;

      const interval = this.config.webcam.snapshotInterval;
      this.debug('Starting snapshot interval: ' + interval + 'ms');

      // Capture immediately
      this._captureAndUploadSnapshot().catch(e => this.debug('Initial snapshot error: ' + e.message));

      // Then on interval
      this._snapshotTimer = setInterval(() => {
        if (this.state.isActive) {
          this._captureAndUploadSnapshot().catch(e => this.debug('Snapshot error: ' + e.message));
        }
      }, interval);
    }

    /**
     * Stops snapshot capture.
     * @private
     */
    _stopSnapshots() {
      if (this._snapshotTimer) {
        clearInterval(this._snapshotTimer);
        this._snapshotTimer = null;
      }
    }

    /**
     * Captures a single snapshot and uploads it.
     * @private
     * @returns {Promise<void>}
     */
    async _captureAndUploadSnapshot() {
      if (!this._webcamVideo || !this._webcamVideo.videoWidth) {
        this.debug('Snapshot skipped: video not ready');
        return;
      }

      const idx = this.state.snapshotIndex++;
      const timestamp = new Date().toISOString();

      try {
        // Use worker for compression off main thread
        const blob = await this._compressSnapshot(this._webcamVideo);
        const size = blob.size;
        this.state.totalSnapshotSize += size;
        const path = this._storagePath(`snapshots/${this.state.sessionId}/snap-${idx}.jpg`);

        const metadata = {
          sessionId: this.state.sessionId,
          attemptId: this.config.attemptId,
          user_email: this.config.userId,
          snapshotIndex: idx,
          timestamp,
          size,
          mimeType: blob.type,
          elapsed: Date.now() - (this.state.startTime || Date.now()),
          path: path
        };

        // Log snapshot captured
        await this._reportEvent('SNAPSHOT_CAPTURED', {
            snapshotIndex: idx,
            timestamp,
            size,
            path: path
        });

        await this._uploadBlob(blob, path, 'snapshot', metadata);

        this.emit('snapshot:captured', metadata);
        this.debug('Snapshot ' + idx + ' uploaded', { size });
      } catch (e) {
        this.emit('snapshot:error', { index: idx, error: e.message });
        this.debug('Snapshot error: ' + e.message);
      }
    }

    /**
     * Compresses a video frame using OffscreenCanvas (worker or main thread).
     * @private
     * @param {HTMLVideoElement} video
     * @returns {Promise<Blob>}
     */
    async _compressSnapshot(video) {
      const { quality, width, height } = this.config.webcam;
      const vw = width || video.videoWidth;
      const vh = height || video.videoHeight;

      if (this._worker && typeof OffscreenCanvas !== 'undefined') {
        // Use worker for compression off main thread
        return this._compressInWorker(video, vw, vh, quality);
      }

      // Fallback: main thread compression
      const canvas = document.createElement('canvas');
      canvas.width = vw;
      canvas.height = vh;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(video, 0, 0, vw, vh);

      return new Promise((resolve, reject) => {
        canvas.toBlob(
          (blob) => blob ? resolve(blob) : reject(new Error('Canvas toBlob failed')),
          'image/jpeg',
          quality
        );
      });
    }

    /**
     * Compresses a snapshot using the upload worker.
     * @private
     * @param {HTMLVideoElement} video
     * @param {number} width
     * @param {number} height
     * @param {number} quality
     * @returns {Promise<Blob>}
     */
    _compressInWorker(video, width, height, quality) {
      return new Promise((resolve, reject) => {
        if (!this._worker) {
          reject(new Error('Worker not available'));
          return;
        }

        const id = uid();

        const handler = (e) => {
          if (e.data.id !== id) return;
          this._worker.removeEventListener('message', handler);
          if (e.data.success) {
            resolve(e.data.blob);
          } else {
            reject(new Error(e.data.error || 'Worker compression failed'));
          }
        };

        this._worker.addEventListener('message', handler);

        // Transfer the video frame to worker
        // We must use createImageBitmap to capture the frame as a transferable object
        createImageBitmap(video).then(bitmap => {
          try {
            this._worker.postMessage({
              id,
              type: 'compress',
              image: bitmap,
              width,
              height,
              quality,
              mimeType: 'image/jpeg',
            }, [bitmap]);
          } catch (e) {
            // Fallback to main thread if transfer fails
            this._worker.removeEventListener('message', handler);
            reject(e);
          }
        }).catch(err => {
          this._worker.removeEventListener('message', handler);
          reject(err);
        });
      });
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Upload Pipeline
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Uploads a blob to Supabase Storage.
     * @private
     * @param {Blob} blob
     * @param {string} path
     * @param {'snapshot'|'chunk'|'log'|'blob'} type
     * @param {Object} metadata
     * @returns {Promise<UploadResult>}
     */
    async _uploadBlob(blob, path, type, metadata = {}) {
      if (!this._sb) {
        return { success: false, error: 'Supabase not initialized', attempts: 1 };
      }

      try {
        const { data, error } = await this._sb.storage
          .from(this.config.upload.storageBucket)
          .upload(path, blob, {
            contentType: blob.type,
            upsert: true,
          });

        if (error) throw error;

        const url = this._sb.storage
          .from(this.config.upload.storageBucket)
          .getPublicUrl(path);

        const result = { success: true, path: data.path || path, url: url.publicUrl };

        this.emit('upload:success', { type, path, url: url.publicUrl, metadata });

        if (this.config.callbacks.onUpload) {
          try { this.config.callbacks.onUpload(result); } catch (e) {}
        }

        return result;
      } catch (err) {
        this.debug('Upload failed (' + type + '): ' + err.message);

        this.emit('upload:error', { type, path, error: err.message, metadata });

        // Add to retry queue
        this.retryQueue.add({
          type,
          data: blob,
          path,
        });

        return { success: false, error: err.message, attempts: 1 };
      }
    }

    /**
     * Chunked upload for large blobs using the worker.
     * @private
     * @param {Blob} blob
     * @param {string} path
     * @param {string} type
     * @param {Object} metadata
     * @returns {Promise<UploadResult>}
     */
    async _chunkedBlobUpload(blob, path, type, metadata) {
      const chunkSize = this.config.upload.chunkUploadSize;
      const totalChunks = Math.ceil(blob.size / chunkSize);

      this.debug('Chunked upload: ' + totalChunks + ' chunks for ' + blob.size + ' bytes');

      const manifest = {
        sessionId: this.state.sessionId,
        type,
        totalChunks,
        chunkSize,
        totalSize: blob.size,
        mimeType: blob.type,
        createdAt: new Date().toISOString(),
        chunks: [],
      };

      for (let i = 0; i < totalChunks; i++) {
        const start = i * chunkSize;
        const end = Math.min(start + chunkSize, blob.size);
        const chunkBlob = blob.slice(start, end);

        const chunkPath = path + `.part-${i}`;
        const result = await this._uploadBlob(chunkBlob, chunkPath, type, { ...metadata, partIndex: i });

        if (!result.success) {
          return result;
        }

        manifest.chunks.push({ index: i, path: chunkPath });
      }

      // Upload manifest
      const manifestBlob = new Blob([safeSerialize(manifest)], { type: 'application/json' });
      await this._uploadBlob(manifestBlob, path + '.manifest.json', 'log', {});

      return { success: true, path, chunks: totalChunks };
    }

    /**
     * Does a snapshot upload (for retry queue).
     * @private
     * @param {string} path
     * @param {Blob} blob
     * @returns {Promise<UploadResult>}
     */
    _doSnapshotUpload(path, blob) {
      return this._uploadBlob(blob, path, 'snapshot');
    }

    /**
     * Does a chunk upload (for retry queue).
     * @private
     * @param {string} path
     * @param {Blob} blob
     * @returns {Promise<UploadResult>}
     */
    _doChunkUpload(path, blob) {
      return this._uploadBlob(blob, path, 'chunk');
    }

    /**
     * Waits for the retry queue to drain.
     * @private
     * @param {number} [timeout=30000]
     */
    async _drainRetryQueue(timeout = 30000) {
      const start = Date.now();
      while (this.retryQueue.getStatus().pending > 0 && Date.now() - start < timeout) {
        await delay(1000);
      }

      if (this.retryQueue.getStatus().pending > 0) {
        this.emit('retry:drain_timeout', {
          remaining: this.retryQueue.getStatus().pending,
        });
      }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Database Logging
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Standardized event reporting.
     * Delegates to AntiCheatSystem via callbacks or emissions.
     * @private
     * @param {string} type
     * @param {Object} data
     */
    async _reportEvent(type, data) {
      const elapsed = Date.now() - (this.state.startTime || Date.now());
      const event = {
          type,
          elapsed,
          timestamp: new Date().toISOString(),
          event_data: data,
          // Support both legacy and unified data structures during delegation
          data: data,
          severity: data.severity,
          score: data.score
      };

      this.emit(type.toLowerCase(), event);
      this.emit('violation', event); // Unified emission for AntiCheat integration

      if (this.config.callbacks.onViolation) {
          try {
              this.config.callbacks.onViolation(event);
          } catch (e) {
              this.debug('onViolation callback failed', e);
          }
      }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Supabase Client
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Initializes the Supabase client.
     * Supports using a global client, direct Supabase JS SDK, or minimal REST API fallback.
     * @private
     */
    async _initSupabase() {
      // Prioritize global window.supabaseClient to avoid multiple GoTrueClient instances
      // and ensure consistent authentication headers.
      if (window.supabaseClient) {
        this._sb = window.supabaseClient;
        this.debug('Using global window.supabaseClient');
        return;
      }

      if (!this.config.supabaseUrl || !this.config.supabaseKey) {
        this.debug('Supabase credentials not provided — storage/DB disabled');
        this._sb = null;
        return;
      }

      // Try to use official Supabase SDK if available
      if (typeof window.supabase !== 'undefined') {
        this._sb = window.supabase.createClient(this.config.supabaseUrl, this.config.supabaseKey);
        this.debug('Using Supabase JS SDK');
        return;
      }

      // Minimal REST client fallback
      this._sb = {
        storage: {
          from: (bucket) => ({
            upload: async (path, blob, opts = {}) => {
              const formData = new FormData();
              formData.append('file', blob);

              const sid = this.state.sessionId || sessionStorage.getItem('sessionId');
              const res = await fetch(
                `${this.config.supabaseUrl}/storage/v1/object/${bucket}/${path}`,
                {
                  method: 'POST',
                  headers: {
                    'Authorization': `Bearer ${this.config.supabaseKey}`,
                    'apikey': this.config.supabaseKey,
                    'x-session-id': sid || '',
                    'x-upsert': opts.upsert ? 'true' : 'false',
                    ...(opts.contentType ? { 'Content-Type': opts.contentType } : {}),
                  },
                  body: blob,
                }
              );

              if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                return { data: null, error: { message: err.message || 'Upload failed' } };
              }

              const data = await res.json();
              return { data: { path }, error: null };
            },
            getPublicUrl: (path) => ({
              publicUrl: `${this.config.supabaseUrl}/storage/v1/object/public/${bucket}/${path}`,
            }),
          }),
        },
        from: (table) => ({
          insert: async (record) => {
            const sid = this.state.sessionId || sessionStorage.getItem('sessionId');
            const res = await fetch(
              `${this.config.supabaseUrl}/rest/v1/${table}`,
              {
                method: 'POST',
                headers: {
                  'Authorization': `Bearer ${this.config.supabaseKey}`,
                  'apikey': this.config.supabaseKey,
                  'x-session-id': sid || '',
                  'Content-Type': 'application/json',
                  'Prefer': 'return=minimal',
                  ...this.config.database.headers,
                },
                body: JSON.stringify(record),
              }
            );

            if (!res.ok) {
              const err = await res.json().catch(() => ({}));
              return { data: null, error: { message: err.message || 'Insert failed' } };
            }

            return { data: record, error: null };
          },
        }),
      };

      this.debug('Using Supabase REST fallback client');
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Connection Monitoring & Reconnection
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Starts monitoring network status and auto-reconnection.
     * @private
     */
    _startConnectionMonitor() {
      window.addEventListener('online', this._onOnline.bind(this));
      window.addEventListener('offline', this._onOffline.bind(this));

      this._connectionCheckTimer = setInterval(() => {
        if (navigator.onLine !== this.state.networkStatus) {
          this.state.networkStatus = navigator.onLine;
          this.emit('network:status_change', { online: navigator.onLine });
        }
      }, 5000);
    }

    /**
     * Stops connection monitoring.
     * @private
     */
    _stopConnectionMonitor() {
      window.removeEventListener('online', this._onOnline.bind(this));
      window.removeEventListener('offline', this._onOffline.bind(this));

      if (this._connectionCheckTimer) {
        clearInterval(this._connectionCheckTimer);
        this._connectionCheckTimer = null;
      }

      if (this._reconnectTimer) {
        clearTimeout(this._reconnectTimer);
        this._reconnectTimer = null;
      }
    }

    /**
     * Handles coming back online.
     * @private
     */
    async _onOnline() {
      this.state.networkStatus = true;
      this.emit('network:online', {});

      if (this.state.reconnectAttempts > 0) {
        await this.reconnect();
      }
    }

    /**
     * Handles going offline.
     * @private
     */
    _onOffline() {
      this.state.networkStatus = false;
      this.state.reconnectAttempts++;
      this.retryQueue.pause();
      this.emit('network:offline', { attempt: this.state.reconnectAttempts });
      this.debug('Network offline, retry queue paused');
    }

    // Cleanup
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Full cleanup of all resources.
     * @private
     */
    _cleanup() {
      this._stopSnapshots();
      this.faceDetector.stop();
      this.noiseDetector.stop();
      this._stopConnectionMonitor();
      this._finalizeScreenRecording();
      this._finalizeAudioRecording();
      this._stopStreams();
      this._destroyWorker();

      if (this._webcamVideo && !this._webcamVideo.parentElement?.querySelector('[data-proctor-webcam]')) {
        this._webcamVideo.remove();
      }
      this._webcamVideo = null;

      this.retryQueue.clear();

      this.emit('cleanup:complete', {});
      this.debug('Cleanup complete');
    }

    /**
     * Stops all media streams.
     * @private
     */
    _stopStreams() {
      if (this.state.webcamStream) {
        this.state.webcamStream.getTracks().forEach(t => t.stop());
        this.state.webcamStream = null;
      }

      if (this.state.screenStream) {
        this.state.screenStream.getTracks().forEach(t => t.stop());
        this.state.screenStream = null;
      }

      if (this.state.mediaRecorder && this.state.mediaRecorder.state !== 'inactive') {
        this.state.mediaRecorder.stop();
        this.state.mediaRecorder = null;
      }

      if (this.state.audioRecorder && this.state.audioRecorder.state !== 'inactive') {
        this.state.audioRecorder.stop();
        this.state.audioRecorder = null;
      }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Worker Management
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Initializes the upload/compression worker.
     * @private
     */
    _initWorker() {
      if (!FEATURES.workers) {
        this.debug('Web Workers not supported — using main thread');
        return;
      }

      try {
        this._worker = createInlineWorker(workerScript);

        this._worker.onerror = (e) => {
          this.debug('Worker error: ' + e.message);
          this.emit('worker:error', { error: e.message });
        };

        this._worker.onmessage = (e) => {
          if (e.data.type === 'pong') return;
          const pending = this._workerPending.get(e.data.id);
          if (pending) {
            pending(e.data);
            this._workerPending.delete(e.data.id);
          }
        };

        this.debug('Upload worker initialized');
      } catch (e) {
        this.debug('Worker creation failed: ' + e.message);
        this._worker = null;
      }
    }

    /**
     * Destroys the upload worker.
     * @private
     */
    _destroyWorker() {
      if (this._worker) {
        this._worker.terminate();
        this._worker = null;
      }
      this._workerPending.clear();
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Local Logging
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Saves logs locally as a JSON file.
     * @private
     * @param {Object} stats
     */
    _saveLocalLogs(stats) {
      try {
        const logs = {
          version: '2.0.0',
          engine: 'ProctorEngine',
          sessionId: this.state.sessionId,
          attemptId: this.config.attemptId,
          userId: this.config.userId,
          startedAt: this.state.startTime ? new Date(this.state.startTime).toISOString() : null,
          endedAt: new Date().toISOString(),
          duration: stats.duration,
          stats,
          deviceInfo: this.state.deviceInfo,
          config: {
            webcam: this.config.webcam,
            screen: this.config.screen,
            upload: { ...this.config.upload, supabaseKey: '[REDACTED]' },
            database: { ...this.config.database, supabaseKey: '[REDACTED]' },
            faceDetection: this.config.faceDetection,
          },
          features: FEATURES,
        };

        const blob = new Blob([safeSerialize(logs)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);

        const a = document.createElement('a');
        a.href = url;
        a.download = `proctor-${this.state.sessionId}.json`;
        a.click();

        URL.revokeObjectURL(url);
        this.debug('Local logs saved');
      } catch (e) {
        this.debug('Local log save failed: ' + e.message);
      }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Helpers
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Builds a storage path with session prefix.
     * @private
     * @param {string} relative
     * @returns {string}
     */
    _storagePath(relative) {
      return `${this.config.upload.storagePath}/${this.config.userId}/${this.config.attemptId}/${relative}`;
    }

    /**
     * Deep merges two config objects.
     * @private
     * @param {Object} base
     * @param {Object} updates
     * @returns {Object}
     */
    _mergeConfig(base, updates) {
      const result = { ...base };
      for (const key in updates) {
        if (typeof updates[key] === 'object' && !Array.isArray(updates[key]) && updates[key] !== null) {
          result[key] = this._mergeConfig(base[key] || {}, updates[key]);
        } else {
          result[key] = updates[key];
        }
      }
      return result;
    }

    /**
     * Gets device/browser information.
     * @private
     * @returns {Object}
     */
    _getDeviceInfo() {
      if (window.DeviceUtils) {
          const ctx = window.DeviceUtils.getFullContext();
          return { ...ctx, features: { ...FEATURES } };
      }

      const ua = navigator.userAgent;
      return {
        browser: 'Unknown',
        os: 'Unknown',
        device: 'Unknown',
        screenWidth: screen.width,
        screenHeight: screen.height,
        colorDepth: screen.colorDepth,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        language: navigator.language,
        cores: navigator.hardwareConcurrency || 'unknown',
        memory: navigator.deviceMemory || 'unknown',
        online: navigator.onLine,
        userAgent: ua,
        features: { ...FEATURES },
      };
    }

    /**
     * Checks browser support and emits warnings for missing features.
     * @private
     */
    _checkBrowserSupport() {
      const missing = [];
      if (!FEATURES.getDisplayMedia) missing.push('getDisplayMedia');
      if (!FEATURES.mediaRecorder) missing.push('MediaRecorder');
      if (!navigator.mediaDevices?.getUserMedia) missing.push('getUserMedia');

      if (missing.length > 0) {
        const err = new Error(`Browser missing required features: ${missing.join(', ')}`);
        this.emit('browser:unsupported', { missing });
        throw err;
      }

      this.emit('browser:checked', { features: FEATURES });
    }

    /**
     * Debug logging helper.
     * @private
     * @param {...*} args
     */
    debug(...args) {
      if (this.config.debug) {
        console.debug('[ProctorEngine]', ...args);
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Export
  // ─────────────────────────────────────────────────────────────────────────────

  // UMD export — works in browser (global), CommonJS, and ES modules
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { ProctorEngine, FEATURES };
  } else {
    global.ProctorEngine = ProctorEngine;
    global.ProctorEngine_FEATURES = FEATURES;
  }

})(typeof globalThis !== 'undefined' ? globalThis : window);
