'use strict';

/** Strip `user:pass@` credentials from a URL before it is logged. */
function redactUrl(value) {
  try {
    const url = new URL(String(value));
    if (url.username || url.password) {
      url.username = '';
      url.password = '';
      return url.toString();
    }
    return String(value);
  } catch {
    return String(value);
  }
}

/**
 * Replace every occurrence of each registered secret in `text` with `***`.
 * Used by the logger so a secret can never reach stdout/stderr even if it is
 * accidentally interpolated into a message or a server error body.
 */
function redactSecrets(text, secrets) {
  let out = String(text);
  for (const secret of secrets) {
    if (secret && secret.length >= 4) out = out.split(secret).join('***');
  }
  return out;
}

module.exports = { redactUrl, redactSecrets };
