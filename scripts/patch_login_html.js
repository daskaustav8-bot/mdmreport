const fs = require('fs');

function patchAdminHtml() {
  let content = fs.readFileSync('admin_login.html', 'utf8');
  const isCrlf = content.includes('\r\n');
  const eol = isCrlf ? '\r\n' : '\n';

  // 1. Session check patch
  const checkOld = `        // Server-side authentication check for already logged-in administrators
        (function checkAuth() {
            fetch('/api/auth/session?admin_type=main', {
                cache: 'no-store',
                credentials: 'same-origin'
            })
            .then(function (response) {
                if (response.ok) {
                    return response.json();
                }
                return null;
            })
            .then(function (data) {
                if (data && data.authenticated && data.admin_type === 'main') {
                    try {
                        sessionStorage.setItem('admin_logged_in', 'true');
                        if (data.username) {
                            sessionStorage.setItem('admin_user', data.username);
                        }
                    } catch (e) {}
                    window.location.replace(data.redirect || '/admin_dashboard');
                }
            })
            .catch(function (err) {
                console.warn('Session check error:', err);
            });
        })();`.replace(/\r?\n/g, eol);

  const checkNew = `        // Server-side authentication check for already logged-in administrators
        (function checkAuth() {
            if (window.location.protocol === 'file:') return;
            const endpoint = (window.location.origin && window.location.origin !== 'null') ? '/api/auth/session?admin_type=main' : 'http://localhost:3000/api/auth/session?admin_type=main';
            fetch(endpoint, {
                cache: 'no-store',
                credentials: 'same-origin'
            })
            .then(function (response) {
                if (response.status === 404) {
                    return fetch('admin_session_check.php').then(r => r.json());
                }
                if (response.ok) {
                    return response.json();
                }
                return null;
            })
            .then(function (data) {
                if (data && data.authenticated && data.admin_type === 'main') {
                    try {
                        sessionStorage.setItem('admin_logged_in', 'true');
                        if (data.username) {
                            sessionStorage.setItem('admin_user', data.username);
                        }
                    } catch (e) {}
                    window.location.replace(data.redirect || '/admin_dashboard');
                }
            })
            .catch(function (err) {
                console.warn('Session check error:', err);
            });
        })();`.replace(/\r?\n/g, eol);

  if (content.includes(checkOld)) {
    content = content.replace(checkOld, checkNew);
    console.log('Patched checkAuth in admin_login.html');
  }

  // 2. Submit patch
  const submitOld = `            fetch('/api/auth/login', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'application/json',
                    'X-Requested-With': 'XMLHttpRequest'
                },
                body: JSON.stringify(payload),
                credentials: 'same-origin'
            })
            .then(function (response) {
                return response.json().then(function (data) {
                    return { status: response.status, ok: response.ok, data: data };
                }).catch(function () {
                    return { status: response.status, ok: response.ok, data: null };
                });
            })`.replace(/\r?\n/g, eol);

  const submitNew = `            const authUrl = (window.location.protocol === 'file:') ? 'http://localhost:3000/api/auth/login' : '/api/auth/login';
            fetch(authUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'application/json',
                    'X-Requested-With': 'XMLHttpRequest'
                },
                body: JSON.stringify(payload),
                credentials: 'same-origin'
            })
            .then(function (response) {
                if (response.status === 404 && window.location.protocol !== 'file:') {
                    return fetch('admin_login_handler.php', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'Accept': 'application/json'
                        },
                        body: JSON.stringify(payload)
                    }).then(function (phpRes) {
                        return phpRes.json().then(function (d) {
                            return { status: phpRes.status, ok: phpRes.ok, data: d };
                        });
                    });
                }
                return response.json().then(function (data) {
                    return { status: response.status, ok: response.ok, data: data };
                }).catch(function () {
                    return { status: response.status, ok: response.ok, data: null };
                });
            })`.replace(/\r?\n/g, eol);

  if (content.includes(submitOld)) {
    content = content.replace(submitOld, submitNew);
    console.log('Patched submit in admin_login.html');
  }

  fs.writeFileSync('admin_login.html', content, 'utf8');
}

function patchInfraHtml() {
  let content = fs.readFileSync('infra_login.html', 'utf8');
  const isCrlf = content.includes('\r\n');
  const eol = isCrlf ? '\r\n' : '\n';

  // 1. Session check patch
  const checkOld = `        // Check session immediately
        (function checkAuth() {
            fetch('/api/auth/session?admin_type=infrastructure', { 
                cache: 'no-store',
                credentials: 'same-origin'
            })
                .then(function (response) {
                    if (response.ok) {
                        return response.json();
                    }
                    return null;
                })
                .then(function (data) {
                    if (data && data.authenticated && data.admin_type === 'infrastructure') {
                        window.location.replace(data.redirect || '/basicinfrastructure');
                    }
                })
                .catch(function (err) {
                    console.warn('Session check error:', err);
                });
        })();`.replace(/\r?\n/g, eol);

  const checkNew = `        // Check session immediately
        (function checkAuth() {
            if (window.location.protocol === 'file:') return;
            const endpoint = (window.location.origin && window.location.origin !== 'null') ? '/api/auth/session?admin_type=infrastructure' : 'http://localhost:3000/api/auth/session?admin_type=infrastructure';
            fetch(endpoint, { 
                cache: 'no-store',
                credentials: 'same-origin'
            })
                .then(function (response) {
                    if (response.status === 404) {
                        return fetch('infra_session_check.php').then(r => r.json());
                    }
                    if (response.ok) {
                        return response.json();
                    }
                    return null;
                })
                .then(function (data) {
                    if (data && data.authenticated && data.admin_type === 'infrastructure') {
                        window.location.replace(data.redirect || '/basicinfrastructure');
                    }
                })
                .catch(function (err) {
                    console.warn('Session check error:', err);
                });
        })();`.replace(/\r?\n/g, eol);

  if (content.includes(checkOld)) {
    content = content.replace(checkOld, checkNew);
    console.log('Patched checkAuth in infra_login.html');
  }

  // 2. Submit patch
  const submitOld = `            fetch('/api/auth/login', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'application/json',
                    'X-Requested-With': 'XMLHttpRequest'
                },
                body: JSON.stringify(payload),
                credentials: 'same-origin'
            })
            .then(function (response) {
                return response.json().then(function (data) {
                    return { status: response.status, ok: response.ok, data: data };
                }).catch(function () {
                    return { status: response.status, ok: response.ok, data: null };
                });
            })`.replace(/\r?\n/g, eol);

  const submitNew = `            const authUrl = (window.location.protocol === 'file:') ? 'http://localhost:3000/api/auth/login' : '/api/auth/login';
            fetch(authUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'application/json',
                    'X-Requested-With': 'XMLHttpRequest'
                },
                body: JSON.stringify(payload),
                credentials: 'same-origin'
            })
            .then(function (response) {
                if (response.status === 404 && window.location.protocol !== 'file:') {
                    return fetch('infra_login_handler.php', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'Accept': 'application/json'
                        },
                        body: JSON.stringify(payload)
                    }).then(function (phpRes) {
                        return phpRes.json().then(function (d) {
                            return { status: phpRes.status, ok: phpRes.ok, data: d };
                        });
                    });
                }
                return response.json().then(function (data) {
                    return { status: response.status, ok: response.ok, data: data };
                }).catch(function () {
                    return { status: response.status, ok: response.ok, data: null };
                });
            })`.replace(/\r?\n/g, eol);

  if (content.includes(submitOld)) {
    content = content.replace(submitOld, submitNew);
    console.log('Patched submit in infra_login.html');
  }

  fs.writeFileSync('infra_login.html', content, 'utf8');
}

patchAdminHtml();
patchInfraHtml();
