// Authentication Logic
const RESET_TAXONOMY = {
    'User Self-Service': {
        reasons: {
            "I'm having trouble logging in": {
                level: 'Low',
                tip: "-Check caps lock.\n-Check the special character used.\n-Try another device."
            },
            'Forgotten Password': {
                level: 'Low',
                tip: 'Use a password manager to keep your credentials safe.'
            },
            'Regular Update': {
                level: 'Low',
                tip: 'Regularly changing passwords helps maintain account health.'
            }
        }
    },
    'Security Incident': {
        reasons: {
            'Compromised Account': {
                level: 'Critical',
                tip: 'Check your active sessions and enable 2FA after resetting.'
            },
            'Suspicious Activity': {
                level: 'High',
                tip: 'Review your login history for unrecognized devices.'
            }
        }
    },
    'Administrative': {
        reasons: {
            'Policy Enforcement': {
                level: 'Medium',
                tip: 'Your organization requires a password update for compliance.'
            },
            'Account Recovery': {
                level: 'Medium',
                tip: 'Ensure your recovery email and phone are up to date.'
            }
        }
    },
    'Device Management': {
        reasons: {
            'Lost/Stolen Device': {
                level: 'High',
                tip: 'Revoke access for the old device in your security settings.'
            },
            'New Primary Device': {
                level: 'Medium',
                tip: 'Always set up new devices on a trusted, secure network.'
            }
        }
    }
};

const Auth = {
    async init() {
        // Parallelize initial checks
        const [user] = await Promise.all([
            SessionManager.getCurrentUser(),
            SupabaseDB.getMaintenance() // Still fetch to keep it in cache/warmup
        ]);

        // Start maintenance banner polling (30s is enough for landing page)
        if (typeof updateMaintBanner === 'function') {
            updateMaintBanner();
            setInterval(updateMaintBanner, 30000);
        }

        // Check for reason or invite token in URL
        const urlParams = new URLSearchParams(window.location.search);
        const reason = urlParams.get('reason');
        if (reason) {
            UI.showNotification(reason, 'info');
            // Clean up the URL
            window.history.replaceState({}, document.title, window.location.pathname);
        }

        const inviteToken = urlParams.get('invite');
        if (inviteToken) {
            await this.handleInvite(inviteToken);
            return;
        }

        // Check for forced password change session
        if (user && user.reset_request && user.reset_request.status === 'approved') {
            this.showNewPassword();
            return;
        }

        this.showSection('landing');
    },

    async handleInvite(token) {
        try {
            const invite = await SupabaseDB.getInvite(token);
            if (!invite) {
                UI.showNotification('Invalid invitation link.', 'error');
                window.location.href = 'index.html';
                return;
            }

            if (invite.used_at) {
                UI.showNotification('This invitation has already been used.', 'warn');
                window.location.href = 'index.html';
                return;
            }

            if (new Date(invite.expires_at) < new Date()) {
                UI.showNotification('This invitation has expired.', 'warn');
                window.location.href = 'index.html';
                return;
            }

            // Valid invite, show signup form with prefilled data
            sessionStorage.setItem('activeInvite', JSON.stringify(invite));
            this.showSignup(invite.role);

            // Apply pre-fills immediately after switching the section view

            // Prefill email and make it readonly if it was specified in the invite
            const emailInput = document.getElementById('email');
            if (emailInput && invite.email) {
                emailInput.value = invite.email;
                if (invite.role === 'admin' || invite.role === 'teacher') {
                    emailInput.readOnly = true;
                }
            }

            // Lock the role selector
            const roleSelect = document.getElementById('role');
            if (roleSelect) {
                roleSelect.value = invite.role;
                roleSelect.disabled = true;
                // Add a visual indicator
                roleSelect.style.backgroundColor = '#f7fafc';
            }

        } catch (e) {
            console.error('Invite handling error:', e);
            UI.showNotification('An error occurred while validating your invite.', 'error');
            window.location.href = 'index.html';
        }
    },

    /**
     * Centralized maintenance check for auth actions.
     * Allows admin bypass if user email is provided.
     */
    async _checkMaintenance(email = null) {
        const m = await SupabaseDB.getMaintenance();
        if (isActiveMaintenance(m)) {
            let allow = false;
            if (email) {
                try {
                    const user = await SupabaseDB.getUser(email);
                    allow = !!(user && user.role === 'admin');
                } catch (_) { allow = false; }
            }

            if (!allow) {
                const untilTs = getActiveMaintenanceEnd(m);
                const untilStr = untilTs ? new Date(untilTs).toLocaleString() : 'the scheduled end time';
                return { active: true, message: `System is currently undergoing maintenance. Access is restricted until ${untilStr}.` };
            }
        }

        const upcoming = getUpcomingMaintenance(m);
        if (upcoming) {
            UI.showNotification(`Upcoming system maintenance: ${new Date(upcoming.startAt).toLocaleString()}`, 'warn');
        }
        return { active: false };
    },

    // ---- Section Switching ----
    showSection(id) {
        const overlay = document.getElementById('authOverlay');
        if (id === 'landing') {
            if (overlay) overlay.classList.remove('active');
            document.querySelectorAll('.container').forEach(c => c.style.display = 'none');
            return;
        }

        document.querySelectorAll('.container').forEach(c => c.style.display = 'none');
        const el = document.getElementById(id);
        if (overlay) overlay.classList.add('active');
        if (el) {
            el.style.display = 'block';
            // Focus first input
            const firstInput = el.querySelector('input');
            if (firstInput) firstInput.focus();
        }
    },

    showRoleAuth(role) {
        this.selectedRole = role;
        this.showLogin();
    },

    showSignup(role) {
        const targetRole = role || this.selectedRole || 'student';
        const titleEl = document.getElementById('signup-title');
        const roleEl = document.getElementById('role');
        const emailEl = document.getElementById('email');

        // Reset state from possible prior invite usage
        if (roleEl) {
            roleEl.value = targetRole;
            roleEl.disabled = false;
        }
        if (emailEl) {
            emailEl.readOnly = false;
            // Only clear if not prefilled by an invite
            if (!sessionStorage.getItem('activeInvite')) emailEl.value = '';
        }

        if (titleEl) titleEl.innerText = `Sign Up as ${targetRole.charAt(0).toUpperCase() + targetRole.slice(1)}`;
        this.showSection('signup');
    },

    showLogin() {
        const titleEl = document.querySelector('#login h2');
        if (titleEl && this.selectedRole) {
            titleEl.innerText = `Login as ${this.selectedRole.charAt(0).toUpperCase() + this.selectedRole.slice(1)}`;
        } else if (titleEl) {
            titleEl.innerText = 'Login';
        }
        this.showSection('login');
    },
    showReset() {
        this.showSection('reset');
        this.initResetFormUI();
    },

    initResetFormUI() {
        const reasonSelect = document.getElementById('resetReason');
        const tipsContainer = document.getElementById('resetTipsContainer');
        const tipsEl = document.getElementById('resetTips');
        if (!reasonSelect) return;

        // Reset state
        reasonSelect.innerHTML = '<option value="">Select Reason...</option>';
        if (tipsContainer) tipsContainer.style.display = 'none';

        // Populate flat list of reasons from taxonomy
        Object.keys(RESET_TAXONOMY).forEach(cat => {
            Object.keys(RESET_TAXONOMY[cat].reasons).forEach(reason => {
                const opt = document.createElement('option');
                opt.value = reason;
                opt.textContent = reason;
                reasonSelect.appendChild(opt);
            });
        });

        // Add change listener for dynamic tips
        reasonSelect.onchange = () => {
            const selected = reasonSelect.value;
            if (!selected || !tipsContainer || !tipsEl) {
                if (tipsContainer) tipsContainer.style.display = 'none';
                return;
            }

            // Find tip in taxonomy
            let foundTip = null;
            Object.values(RESET_TAXONOMY).forEach(cat => {
                if (cat.reasons[selected]) foundTip = cat.reasons[selected].tip;
            });

            if (foundTip) {
                tipsEl.textContent = foundTip;
                tipsContainer.style.display = 'block';
            } else {
                tipsContainer.style.display = 'none';
            }
        };
    },
    showNewPassword() { this.showSection('newPassword'); },

    closeAuth() {
        const overlay = document.getElementById('authOverlay');
        if (overlay) overlay.classList.remove('active');
        document.querySelectorAll('.container').forEach(c => c.style.display = 'none');

        // Reset invite-related states
        sessionStorage.removeItem('activeInvite');
        const roleEl = document.getElementById('role');
        const emailEl = document.getElementById('email');
        if (roleEl) roleEl.disabled = false;
        if (emailEl) emailEl.readOnly = false;
    },


    redirectByRole(role) {
        if (role === 'student') window.location.href = 'student.html';
        else if (role === 'teacher') window.location.href = 'teacher.html';
        else if (role === 'admin') window.location.href = 'admin.html';
    },

};

// Global helpers (accessible from onclick)
window.showRoleAuth = (role) => Auth.showRoleAuth(role);
window.showSignup = (role) => Auth.showSignup(role);
window.showLogin = () => Auth.showLogin();
window.showReset = () => Auth.showReset();
window.showSection = (id) => Auth.showSection(id);
window.closeAuth = () => Auth.closeAuth();

// Event Listeners
document.addEventListener('DOMContentLoaded', () => {
    Auth.init();

    // Check for certificate verification deep link
    const urlParams = new URLSearchParams(window.location.search);
    const page = urlParams.get('page');
    const certId = urlParams.get('id');

    if (page === 'verify' && certId && typeof LandingUI !== 'undefined') {
        LandingUI.showVerification(certId);
    }

    const signupPassword = document.getElementById('password');
    if (signupPassword) {
        signupPassword.addEventListener('input', (e) => {
            window.updatePasswordStrength(e.target.value);
        });
    }

    const newPassInput = document.getElementById('newPass');
    if (newPassInput) {
        newPassInput.addEventListener('input', (e) => {
            window.updatePasswordStrength(e.target.value, 'newPasswordStrength', 'newPasswordStrengthContainer');
        });
    }

    // ---- Signup ----
    const signupForm = document.getElementById('signupForm');
    if (signupForm) {
        signupForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const maint = await Auth._checkMaintenance();
            if (maint.active) {
                alert(maint.message);
                return;
            }

            const fullName = (document.getElementById('fullName').value || '').trim();
            const email = normalizeEmail(document.getElementById('email').value);
            const phone = (document.getElementById('phone').value || '').trim();
            const password = document.getElementById('password').value;
            const confirm = document.getElementById('confirmPassword').value;
            const role = (document.getElementById('role').value || 'student');

            const errorEl = document.getElementById('signupError');
            ValidationUI.clearError(errorEl);

            const vName = Validator.fullName(fullName);
            if (!vName.valid) return ValidationUI.showError(errorEl, vName.message);

            const vEmail = Validator.email(email);
            if (!vEmail.valid) return ValidationUI.showError(errorEl, vEmail.message);

            const vPhone = Validator.phone(phone);
            if (!vPhone.valid) return ValidationUI.showError(errorEl, vPhone.message);

            // Enforce limit of 1 account for admin and teacher roles for landing page signups
            // Bypassed if using a valid invitation
            const activeInviteRaw = sessionStorage.getItem('activeInvite');
            let activeInvite = null;
            if (activeInviteRaw) {
                try { activeInvite = JSON.parse(activeInviteRaw); } catch (e) { console.warn('Corrupt invite session data'); }
            }

            if ((role === 'admin' || role === 'teacher') && !activeInvite) {
                try {
                    const roleCount = await SupabaseDB.getCount('users', q => q.eq('role', role));
                    if (roleCount >= 1) {
                        const roleName = role.charAt(0).toUpperCase() + role.slice(1);
                        return ValidationUI.showError(errorEl, `The maximum number of ${roleName} accounts has been reached. Please contact an existing admin to create more accounts.`);
                    }
                } catch (e) {
                    console.error(`Error checking ${role} count:`, e);
                }
            }

            const existing = await SupabaseDB.getUser(email);
            // Re-auth/Reclamation logic: If user exists in users table but has no secret/password,
            // allow signup to proceed to create credentials for them.
            if (existing && existing.has_secret) {
                if (existing.reset_request) {
                    if (existing.reset_request.status === 'pending') {
                        return ValidationUI.showError(errorEl, 'This account has an active password reset request pending admin review. You cannot sign up again.');
                    }
                    if (existing.reset_request.status === 'approved') {
                        const tempPass = existing.reset_data?.temp_password_plain || '[Contact Admin]';
                        return ValidationUI.showErrorHTML(errorEl, `This account has an approved password reset. Please use the temporary password provided by your administrator to login: <br><strong style="font-family:monospace; font-size:1.1rem; letter-spacing:1px; display:block; margin-top:5px; background:rgba(0,0,0,0.05); padding:5px; border-radius:4px">${escapeHtml(tempPass)}</strong>`);
                    }
                }
                return ValidationUI.showError(errorEl, 'Account with this email already exists.');
            }
            if (password !== confirm) {
                return ValidationUI.showError(errorEl, 'Passwords do not match.');
            }
            const vPass = Validator.password(password);
            if (!vPass.valid) return ValidationUI.showError(errorEl, vPass.message);

            try {
                const hashedPassword = await window.hashPassword(password, email);

                // Generate a fresh session ID for the new signup
                const sid = SessionManager.getSessionId(true);

                const user = {
                    full_name: fullName,
                    email,
                    phone,
                    password: hashedPassword,
                    role,
                    session_id: sid,
                    invite_token: activeInvite?.token || null
                };

                const savedUser = await SupabaseDB.saveUser(user);
                if (!savedUser) {
                    return ValidationUI.showError(errorEl, 'Failed to create account. Please try again.');
                }

                // Establish RLS session context
                window.setSupabaseSession(sid);

                // Mark invite as used if applicable
                if (activeInvite) {
                    try {
                        await SupabaseDB.markInviteUsed(activeInvite.token);
                        sessionStorage.removeItem('activeInvite');
                    } catch (e) {
                        console.warn('Failed to mark invite as used:', e);
                    }
                }

                await SessionManager.setCurrentUser(savedUser);
                alert(`Welcome ${fullName}! Your ${role} account has been created.`);
                Auth.redirectByRole(role);
            } catch (err) {
                console.error('Signup error:', err);
                ValidationUI.showError(errorEl, err.message || 'An error occurred during signup. Please try again.');
            }
        });
    }

    // ---- Login ----
    const loginForm = document.getElementById('loginForm');
    if (loginForm) {
        loginForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const email = normalizeEmail(document.getElementById('loginEmail').value);
            const password = document.getElementById('loginPassword').value;
            const emailErr = document.getElementById('loginEmailError');
            const passErr = document.getElementById('loginPasswordError');

            ValidationUI.clearError(emailErr);
            ValidationUI.clearError(passErr);

            const vEmail = Validator.email(email);
            if (!vEmail.valid) return ValidationUI.showError(emailErr, vEmail.message);

            if (!password) return ValidationUI.showError(passErr, 'Password is required.');

            const maint = await Auth._checkMaintenance(email);
            if (maint.active) {
                alert(maint.message);
                return;
            }

            const user = await SupabaseDB.getUser(email);

            if (!user) {
                return ValidationUI.showError(emailErr, 'No account found with this email');
            }

            if (isAccountLocked(user)) {
                const mins = Math.ceil((new Date(user.locked_until).getTime() - Date.now()) / 60000);
                return ValidationUI.showError(passErr, `Account is locked. Try again in ${mins} minutes`);
            }

            // Handle expired/status-based reset restrictions
            // Note: We avoid client-side SupabaseDB.saveUser here as it violates RLS for unauthenticated users.
            // The authenticate_user RPC and purge_expired_records trigger handle these server-side.

            if (user.reset_request) {
                if (user.reset_request.status === 'denied') {
                    return ValidationUI.showError(passErr, `Reset Request Denied: ${user.reset_request.denial_reason || 'No reason provided.'}`);
                }
                if (user.reset_request.status === 'pending') {
                    return ValidationUI.showError(passErr, 'Password reset request pending admin review.');
                }
                if (user.reset_request.status === 'approved') {
                    if (user.reset_request.expires_at && Date.now() > new Date(user.reset_request.expires_at).getTime()) {
                        user.reset_request = null;
                        await SupabaseDB.saveUser(user);
                        return ValidationUI.showError(passErr, 'Temporary password expired. Please request a new reset.');
                    }
                    // Explicitly pass temp password in session for potential UI checks
                    if (user.reset_data?.temp_password_plain) {
                         sessionStorage.setItem('lastApprovedTemp', user.reset_data.temp_password_plain);
                    }
                }
            }

            const hashedInput = await window.hashPassword(password, email);

            try {
                // Clear existing session and generate a fresh one BEFORE authentication
                const sid = SessionManager.getSessionId(true);

                const authResult = await SupabaseDB.authenticateUser(email, hashedInput, sid);

                if (!authResult.success) {
                    if (authResult.temp_password) {
                        return ValidationUI.showErrorHTML(passErr, `${authResult.message}<br><strong style="font-family:monospace; font-size:1.1rem; letter-spacing:1px; display:block; margin-top:5px; background:rgba(0,0,0,0.05); padding:5px; border-radius:4px">${escapeHtml(authResult.temp_password)}</strong>`);
                    }
                    return ValidationUI.showError(passErr, authResult.message || 'Login failed');
                }

                const authUser = authResult.user;

                // Establish RLS session context immediately after successful auth
                window.setSupabaseSession(sid);
                await SessionManager.setCurrentUser(authUser);

                // Handle approved reset redirection
                if (authUser.reset_request && authUser.reset_request.status === 'approved') {
                    // Cache the plain text temp password if available for reuse in new password screen
                    if (authUser.reset_data?.temp_password_plain) {
                        sessionStorage.setItem('lastApprovedTemp', authUser.reset_data.temp_password_plain);
                    }
                    Auth.showNewPassword();
                    return;
                }

                // If user was in approved reset state but somehow bypassed or finished,
                // we ensure they are clean.
                alert(`Welcome back ${authUser.full_name}!`);
                Auth.redirectByRole(authUser.role);

            } catch (err) {
                console.error('Auth error:', err);
                ValidationUI.showError(passErr, 'An error occurred during login. Please try again.');
            }
        });
    }

    // ---- Reset Request ----
    const resetForm = document.getElementById('resetForm');
    if (resetForm) {
        resetForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const email = normalizeEmail(document.getElementById('resetEmail').value);
            const reason = document.getElementById('resetReason').value;
            const customReason = document.getElementById('resetCustomReason')?.value || '';

            const err = document.getElementById('resetError');
            ValidationUI.clearError(err);

            const vEmail = Validator.email(email);
            if (!vEmail.valid) return ValidationUI.showError(err, vEmail.message);

            if (!reason) {
                return ValidationUI.showError(err, 'Please select a reason.');
            }

            const maint = await Auth._checkMaintenance(email);
            if (maint.active) {
                return ValidationUI.showError(err, maint.message);
            }

            try {
                const result = await SupabaseDB.requestPasswordReset(email, reason, customReason);
                if (!result.success) {
                    if (result.temp_password) {
                        return ValidationUI.showErrorHTML(err, `${result.message}<br><strong style="font-family:monospace; font-size:1.1rem; letter-spacing:1px; display:block; margin-top:5px; background:rgba(0,0,0,0.05); padding:5px; border-radius:4px">${escapeHtml(result.temp_password)}</strong>`);
                    }
                    return ValidationUI.showError(err, result.message);
                }
                alert(result.message);
                Auth.showLogin();
            } catch (e) {
                console.error('Reset request error:', e);
                ValidationUI.showError(err, 'An error occurred. Please try again later.');
            }
        });
    }

    // ---- New Password ----
    const newPasswordForm = document.getElementById('newPasswordForm');
    if (newPasswordForm) {
        newPasswordForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            let user = await SessionManager.getCurrentUser();

            const newPass = document.getElementById('newPass').value;
            const confirm = document.getElementById('confirmNewPass').value;

            const err = document.getElementById('newPasswordError');
            ValidationUI.clearError(err);

            if (!user) {
                ValidationUI.showError(err, 'Session expired. Please login again with temporary password.');
                Auth.showLogin();
                return;
            }

            // Validate reset approval still valid
            const freshUser = await SupabaseDB.getUser(user.email);
            if (!freshUser.reset_request || freshUser.reset_request.status !== 'approved') {
                ValidationUI.showError(err, 'No active reset found. Please request a new reset.');
                Auth.showReset();
                return;
            }
            if (freshUser.reset_request.expires_at && Date.now() > new Date(freshUser.reset_request.expires_at).getTime()) {
                freshUser.reset_request = null;
                // Since this user IS logged in (via temp password), saveUser is allowed by RLS
                await SupabaseDB.saveUser(freshUser);
                ValidationUI.showError(err, 'Temporary password expired. Please request a new reset.');
                Auth.showReset();
                return;
            }

            if (newPass !== confirm) {
                return ValidationUI.showError(err, 'Passwords do not match.');
            }
            const vPass = Validator.password(newPass);
            if (!vPass.valid) return ValidationUI.showError(err, vPass.message);

            // Prevent using the same temporary password
            const hashedNew = await window.hashPassword(newPass, freshUser.email);
            const lastTemp = sessionStorage.getItem('lastApprovedTemp');
            if (hashedNew === freshUser.reset_data?.temp_password || (lastTemp && newPass === lastTemp)) {
                return ValidationUI.showError(err, 'New password cannot be the same as your temporary password.');
            }

            // Atomic Finalization: Update password and clear reset state in one RPC call
            try {
                const finalSid = SessionManager.getSessionId(true);
                const result = await SupabaseDB.finalizePasswordReset(freshUser.email, hashedNew, finalSid);

                if (!result.success) {
                    throw new Error(result.message || 'Finalization failed');
                }

                // Notify user of update
                await SupabaseDB.createNotification(
                    freshUser.email,
                    'Password Updated',
                    'Password updated after reset.',
                    null,
                    'password_updated'
                );

                alert('Password successfully reset. You MUST now login with your new permanent password.');

                // Force re-authentication by clearing the local session to finalize the "used" state
                sessionStorage.removeItem('lastApprovedTemp');
                await SessionManager.clearCurrentUser('password_change_finalized');
                Auth.showLogin();

            } catch (finErr) {
                console.error('Password reset finalization failed:', finErr);
                return ValidationUI.showError(err, finErr.message || 'Failed to finalize password reset. Please try again.');
            }
        });
    }
});
