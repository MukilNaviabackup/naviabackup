async function hmacSha256Hex(secret, message) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false, ['sign']
  );
  const sigBuffer = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return Array.from(new Uint8Array(sigBuffer))
    .map(b => b.toString(16).padStart(2, '0')).join('');
}

async function generate() {
  const secret = document.getElementById('secret').value.trim();
  const ucc = document.getElementById('ucc').value.trim();
  const resultDiv = document.getElementById('result');
  resultDiv.style.display = 'block';

  if (!secret || !ucc) {
    resultDiv.innerHTML = '<span class="warn">Please fill in both the secret and the UCC.</span>';
    return;
  }
  if (secret.length !== 64) {
    resultDiv.innerHTML = '<span class="warn">Warning: secret is ' + secret.length + ' characters long, expected 64. Double-check you copied the full value.</span>';
    return;
  }

  const ts = Date.now();
  const sig = await hmacSha256Hex(secret, ucc + '|' + ts);
  const url = 'https://backup.navia.co.in/api/auth/sso?ucc=' + encodeURIComponent(ucc) + '&ts=' + ts + '&sig=' + sig;

  resultDiv.innerHTML =
    '<span class="ok">Secret length OK (64 chars).</span><br><br>' +
    'Test URL (valid ~5 minutes):<br>' +
    '<a href="' + url + '" target="_blank">' + url + '</a>';
}

document.getElementById('generateBtn').addEventListener('click', generate);
