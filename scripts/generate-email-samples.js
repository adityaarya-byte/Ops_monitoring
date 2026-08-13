/**
 * Writes Gmail-style HTML previews for Amber / Red / Black / Cleared emails.
 * Run: node scripts/generate-email-samples.js
 */

const fs = require('fs');
const path = require('path');
const {
  getSamplePayloads,
  buildEmailHtml,
  buildAlertSubject,
  SEVERITY_THEME
} = require('../src/commodity-bad-debt');

const OUT = path.join(__dirname, '..', 'commodity-bad-debt-alert', 'email-samples');

function gmailCard(payload) {
  const theme = SEVERITY_THEME[payload.severity] || SEVERITY_THEME.AMBER;
  const subject = buildAlertSubject(payload.severity, payload.formattedValue, false);
  const from = 'Commodity Bad Debt Alert';
  return (
    '<article class="card">' +
      '<div class="inbox">' +
        '<div class="bar" style="background:' + theme.color + '"></div>' +
        '<div class="inbox-body">' +
          '<div class="from">' + from + '</div>' +
          '<div class="subject">' + subject + '</div>' +
          '<div class="meta">To: desk · 14:33 IST · Gmail HTML</div>' +
        '</div>' +
      '</div>' +
      '<div class="body">' + buildEmailHtml(payload) + '</div>' +
    '</article>'
  );
}

function page(title, inner, extraStyle) {
  return (
    '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">' +
    '<title>' + title + '</title>' +
    '<style>' +
      'body{margin:0;background:#E8EAED;font-family:Arial,Helvetica,sans-serif;color:#202124}' +
      'h1{font-size:20px;margin:0 0 8px}' +
      '.wrap{max-width:1280px;margin:0 auto;padding:24px}' +
      '.lede{color:#5F6368;margin:0 0 20px;font-size:14px;line-height:1.45}' +
      '.grid{display:grid;grid-template-columns:1fr 1fr;gap:20px}' +
      '.card{background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.12)}' +
      '.inbox{display:flex;border-bottom:1px solid #E8EAED}' +
      '.bar{width:8px;flex:0 0 8px}' +
      '.inbox-body{padding:10px 14px}' +
      '.from{font-size:13px;font-weight:bold}' +
      '.subject{font-size:14px;margin-top:2px}' +
      '.meta{font-size:11px;color:#80868B;margin-top:4px}' +
      '.body{padding:16px;background:#F8F9FA}' +
      (extraStyle || '') +
    '</style></head><body><div class="wrap">' + inner + '</div></body></html>'
  );
}

fs.mkdirSync(OUT, { recursive: true });

const samples = getSamplePayloads();
const cards = samples.map(gmailCard).join('');

const galleryInner =
  '<h1>Commodity bad debt — email alerts (all conditions)</h1>' +
  '<p class="lede">These are the four messages Apps Script sends. Inbox line = Gmail subject. Colored header + highlighted threshold row = body. Live mail uses the same HTML (without the [SAMPLE] prefix unless you run sendSampleAlertEmails).</p>' +
  '<div class="grid">' + cards + '</div>';

fs.writeFileSync(path.join(OUT, 'index.html'), page('Q37 email samples', galleryInner));

samples.forEach(function (p) {
  const inner =
    '<h1>' + (p.severity === 'NONE' ? 'CLEARED' : p.severity) + ' email</h1>' +
    '<p class="lede">Subject: ' + buildAlertSubject(p.severity, p.formattedValue, false) + '</p>' +
    gmailCard(p);
  fs.writeFileSync(
    path.join(OUT, p.key + '.html'),
    page('Q37 ' + p.key + ' email', inner, '.grid{display:block}')
  );
});

console.log('Wrote email samples to ' + OUT);
