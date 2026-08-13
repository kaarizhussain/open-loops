/* Gmail and Calendar → the shape loops.js expects.
 *
 * The pure parts live here so they can be tested outside Apps Script. The only
 * genuinely hard one is stripping quoted replies: every reply carries the whole
 * prior thread, so without this the detector re-finds the same promise in every
 * message and the list fills with duplicates of one commitment.
 */

/* Where a reply stops being new text and starts being the old thread. */
var REPLY_BOUNDARY = [
  /^On .+ wrote:$/,                    // Gmail
  /^On .+,.*<.+@.+>.*wrote:$/,         // Gmail, wrapped onto one line
  /^-{2,}\s*Original Message\s*-{2,}/i, // Outlook
  /^_{5,}$/,                           // Outlook divider
  /^From:\s*.+$/,                      // Outlook header block
  /^Sent from my /i                    // mobile signature, everything after is noise
];

function isBoundary(line) {
  var l = line.trim();
  for (var i = 0; i < REPLY_BOUNDARY.length; i++) if (REPLY_BOUNDARY[i].test(l)) return true;
  return false;
}

function cleanBody(text) {
  var lines = String(text || '').split(/\r?\n/), out = [];
  for (var i = 0; i < lines.length; i++) {
    var l = lines[i];
    if (isBoundary(l)) break;          // everything below is the thread we already read
    if (/^\s*>/.test(l)) continue;     // inline quoting
    if (/^--\s*$/.test(l.trimRight())) break;  // signature delimiter
    out.push(l);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/* "Paul Oyelaran <paul@meridian.com>" → "paul@meridian.com" */
function addr(s) {
  var m = String(s || '').match(/<([^>]+)>/);
  return (m ? m[1] : String(s || '')).trim().toLowerCase();
}
function addrList(s) {
  return String(s || '').split(',').map(addr).filter(Boolean);
}

if (typeof module !== 'undefined') {
  module.exports = { cleanBody: cleanBody, addr: addr, addrList: addrList, isBoundary: isBoundary };
}
