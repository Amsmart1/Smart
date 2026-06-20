const LandingUI = {
    showInfoModal(type) {
        const content = document.getElementById('infoModalContent');
        const overlay = document.getElementById('infoOverlay');
        if (!content || !overlay) return;

        const info = HELP_DATA.infoModals[type];
        if (!info) return;

        content.innerHTML = `<h2>${info.title}</h2>${info.content}`;
        overlay.classList.add('active');
    },

    closeInfoModal() {
        document.getElementById('infoOverlay').classList.remove('active');
    },

    showContactUs() {
        const content = document.getElementById('infoModalContent');
        const overlay = document.getElementById('infoOverlay');
        if (!content || !overlay) return;

        content.innerHTML = `
            <div class="text-center">
                <div class="contact-header-icon">📞</div>
                <h2>Contact Us</h2>
                <p class="text-muted mb-30">Get in touch with our team for any business inquiries or urgent matters.</p>

                <div class="contact-card">
                    <div class="contact-item">
                        <div class="contact-icon email-bg">📧</div>
                        <div class="contact-info">
                            <div class="contact-label email-color">Email Address</div>
                            <div class="contact-value">${HELP_DATA.contact.email}</div>
                        </div>
                    </div>
                    <div class="contact-item">
                        <div class="contact-icon phone-bg">📞</div>
                        <div class="contact-info">
                            <div class="contact-label phone-color">Phone Number</div>
                            <div class="contact-value">${HELP_DATA.contact.phone}</div>
                        </div>
                    </div>
                </div>

                <p class="tiny text-muted mt-20">Our team is available ${HELP_DATA.contact.hours}.</p>
                <button class="button primary mt-20 w-auto" onclick="LandingUI.closeInfoModal()">Close</button>
            </div>
        `;
        overlay.classList.add('active');
    },

    showHelpCenter() {
        const content = document.getElementById('helpCenterContent');
        const overlay = document.getElementById('helpCenterOverlay');
        if (!content || !overlay) return;

        const roleCards = Object.entries(HELP_DATA.roles).map(([id, role]) => `
            <div class="flippable-card" id="card-${id}" onclick="LandingUI.selectRole('${id}')">
                <div class="flippable-card-inner">
                    <div class="flippable-card-front">
                        <div class="icon" style="font-size: 3.5rem; margin-bottom: 1rem;">${role.icon}</div>
                        <span style="font-size: 1.25rem; font-weight: 700;">${role.title}</span>
                    </div>
                    <div class="flippable-card-back">
                        <p style="font-weight: 600; color: var(--p);">${role.description}</p>
                        <button class="button primary tiny mt-10">Select</button>
                    </div>
                </div>
            </div>
        `).join('');

        content.innerHTML = `
            <div id="helpCenterHero" class="help-center-hero" style="background: var(--bg); padding: 60px 20px; text-align: center; transition: all 0.4s ease;">
                <h1 style="font-size: 2.5rem; margin-bottom: 10px;">Help Center</h1>
                <p class="text-muted">How can we help you today? Please select your role to continue.</p>

                <div class="role-grid help-center-roles" style="max-width: 900px; margin: 40px auto 0;">
                    ${roleCards}
                </div>
            </div>
            <div id="helpCenterBodyContainer" style="flex: 1; overflow: hidden; display: none;"></div>
        `;

        overlay.classList.add('active');

        // Add flip listeners - Mouse only, touch is handled by click
        document.querySelectorAll('.flippable-card').forEach(card => {
            card.addEventListener('mouseenter', () => card.classList.add('flipped'));
            card.addEventListener('mouseleave', () => card.classList.remove('flipped'));
        });
    },

    selectRole(role) {
        console.log('[LandingUI] selectRole:', role);
        const hero = document.getElementById('helpCenterHero');
        if (hero) hero.classList.add('minimized');

        const isMobile = window.innerWidth <= 768;

        // Highlight selected role card visually by adding a class or just shrinking others
        document.querySelectorAll('.flippable-card').forEach(c => {
            if (c.id !== `card-${role}`) {
                if (isMobile) {
                    c.style.display = 'none';
                } else {
                    c.style.opacity = '0.5';
                    c.style.pointerEvents = 'none';
                }
            } else {
                c.style.opacity = '1';
                if (isMobile) {
                    c.style.height = 'auto';
                    c.style.transform = 'scale(0.9)';
                    // Reset flip for better mobile view of selected item
                    const inner = c.querySelector('.flippable-card-inner');
                    if (inner) inner.style.transform = 'none';
                    c.classList.remove('flipped');
                } else {
                    c.style.transform = 'scale(0.9)';
                }
            }
        });

        this.renderHelpCenter(role);
    },

    async renderHelpCenter(role) {
        console.log('[LandingUI] renderHelpCenter:', role);
        const bodyContainer = document.getElementById('helpCenterBodyContainer');
        if (!bodyContainer) return;

        bodyContainer.style.display = 'block';
        HelpSystem.renderHelpCenter('helpCenterBodyContainer', role, { isModal: true });
    },

    closeHelpCenter() {
        document.getElementById('helpCenterOverlay').classList.remove('active');
    },

    async showVerification(verificationId) {
        if (!verificationId) return;

        const content = document.getElementById('infoModalContent');
        const overlay = document.getElementById('infoOverlay');
        if (!content || !overlay) return;

        overlay.classList.add('active');
        content.innerHTML = `
            <div class="flex-center flex-column p-40">
                <div class="loading-spinner mb-20"></div>
                <p class="text-muted">Verifying Certificate Integrity...</p>
            </div>
        `;

        try {
            const cert = await SupabaseDB.verifyCertificate(verificationId);

            if (cert && cert.status === 'approved') {
                const studentName = cert.student_name || 'Verified Student';
                const courseTitle = cert.course_title;
                const issueDate = new Date(cert.issued_at).toLocaleDateString(undefined, { dateStyle: 'long' });

                content.innerHTML = `
                    <div class="text-center p-20">
                        <div style="font-size: 5rem; margin-bottom: 20px;">🛡️</div>
                        <h2 class="success-text m-0">Certificate Verified</h2>
                        <p class="text-muted mb-30">This is an authentic SmartLMS Certificate of Completion.</p>

                        <div class="card" style="background: var(--bg); border: 1px solid var(--border); text-align: left; padding: 25px;">
                            <div class="mb-15">
                                <label class="tiny text-muted uppercase bold" style="letter-spacing: 1px;">Recipient Name</label>
                                <div class="bold" style="font-size: 1.25rem;">${escapeHtml(studentName)}</div>
                            </div>
                            <div class="mb-15">
                                <label class="tiny text-muted uppercase bold" style="letter-spacing: 1px;">Course Title</label>
                                <div class="bold" style="font-size: 1.1rem; color: var(--purple);">${escapeHtml(courseTitle)}</div>
                            </div>
                            <div class="grid-2 gap-20">
                                <div>
                                    <label class="tiny text-muted uppercase bold" style="letter-spacing: 1px;">Issue Date</label>
                                    <div class="bold">${escapeHtml(issueDate)}</div>
                                </div>
                                <div>
                                    <label class="tiny text-muted uppercase bold" style="letter-spacing: 1px;">Verification ID</label>
                                    <div class="bold" style="font-family: monospace;">${escapeHtml(verificationId)}</div>
                                </div>
                            </div>
                        </div>

                        <div class="flex gap-10 mt-30">
                            <button class="button primary w-auto px-40" onclick="LandingUI.closeInfoModal()">Done</button>
                            ${cert.certificate_url ? `<button class="button secondary w-auto px-40" onclick="UI.viewFile('${escapeAttr(cert.certificate_url)}', 'Verified Certificate')">View PDF</button>` : ''}
                        </div>
                    </div>
                `;
            } else if (cert) {
                content.innerHTML = `
                    <div class="text-center p-40">
                        <div style="font-size: 5rem; margin-bottom: 20px;">⏳</div>
                        <h2 class="warning-text">Verification Pending</h2>
                        <p class="text-muted mb-30">This certificate record was found, but it is currently awaiting official approval from the institution.</p>
                        <button class="button primary w-auto px-40" onclick="LandingUI.closeInfoModal()">Close</button>
                    </div>
                `;
            } else {
                content.innerHTML = `
                    <div class="text-center p-40">
                        <div style="font-size: 5rem; margin-bottom: 20px;">❌</div>
                        <h2 class="danger-text">Verification Failed</h2>
                        <p class="text-muted mb-30">We couldn't find a record for this certificate ID or it hasn't been officially approved yet.</p>
                        <button class="button primary w-auto px-40" onclick="LandingUI.closeInfoModal()">Close</button>
                    </div>
                `;
            }
        } catch (e) {
            console.error('[LandingUI] Verification error:', e);
            content.innerHTML = `
                <div class="text-center p-40">
                    <h2 class="danger-text">System Error</h2>
                    <p class="text-muted">An error occurred during verification. Please try again later.</p>
                    <button class="button secondary w-auto px-40" onclick="LandingUI.closeInfoModal()">Close</button>
                </div>
            `;
        }
    }
};

window.LandingUI = LandingUI;
