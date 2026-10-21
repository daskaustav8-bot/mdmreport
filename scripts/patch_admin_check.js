const fs = require('fs');

let content = fs.readFileSync('admin_login.html', 'utf8');
const isCrlf = content.includes('\r\n');
const eol = isCrlf ? '\r\n' : '\n';

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
            })`.replace(/\r?\n/g, eol);

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
            })`.replace(/\r?\n/g, eol);

if (content.includes(checkOld)) {
    content = content.replace(checkOld, checkNew);
    fs.writeFileSync('admin_login.html', content, 'utf8');
    console.log('Successfully updated checkAuth in admin_login.html');
} else {
    console.log('checkOld not found');
}
