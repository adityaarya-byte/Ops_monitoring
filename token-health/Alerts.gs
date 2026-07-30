/**
 * Alert logging + email notifications for coverage / D1W1 changes.
 */

function sendDegradationEmail_(token, timestampString, alertSubject, alertBodyDetails) {
  var htmlBody =
    '<div style="font-family: \'Courier New\', Courier, monospace; max-width: 650px; background-color: #0B1220; border: 2px solid #ff4d4d; padding: 20px; border-radius: 4px; color: #ffffff;">' +
    '<h2 style="color: #ff4d4d; margin-top: 0; font-size: 20px; border-bottom: 1px solid #ff4d4d; padding-bottom: 10px; letter-spacing: 1px;">🚨 OPERATIONAL DEGRADATION ALERT</h2>' +
    '<table style="width: 100%; border-collapse: collapse; margin: 20px 0; font-size: 14px; color: #e2e8f0;">' +
    '<tr style="border-bottom: 1px solid #1A202C;"><td style="padding: 10px 5px; color: #718096; width: 45%;">Date/Time Verified</td><td style="padding: 10px 5px; font-weight: bold; color: #38bdf8;">' +
    timestampString +
    '</td></tr>' +
    '<tr style="border-bottom: 1px solid #1A202C;"><td style="padding: 10px 5px; color: #718096;">Token Symbol</td><td style="padding: 10px 5px; font-weight: bold; color: #fb923c;">' +
    token +
    '</td></tr>' +
    alertBodyDetails +
    '</table>' +
    '<hr style="border: 0; border-top: 1px solid #1A202C; margin: 20px 0;">' +
    '<p style="font-size: 11px; color: #4a5568; text-align: center; margin-bottom: 0;">Automated Transmission // CoinDCX Operations Command Center Tracking Engine</p>' +
    '</div>';

  var teamRecipients = (CONFIG.ALERT_RECIPIENTS || []).join(',');
  if (!teamRecipients) {
    Logger.log('⚠️ No alert recipients configured.');
    return;
  }

  MailApp.sendEmail({
    to: teamRecipients,
    subject: alertSubject,
    htmlBody: htmlBody,
    name: 'Token Health Chain Metrix'
  });
}

function appendAlerts_(alertsSheet, incomingAlertsList) {
  if (alertsSheet.getLastRow() === 0) {
    alertsSheet.appendRow([
      'Date/Time Verified',
      'Token Symbol',
      'Previous Count',
      'Current Count',
      'Detailed Status Alert Message'
    ]);
    alertsSheet.getRange('A1:E1').setFontWeight('bold');
  }

  if (incomingAlertsList.length > 0) {
    alertsSheet
      .getRange(alertsSheet.getLastRow() + 1, 1, incomingAlertsList.length, 5)
      .setValues(incomingAlertsList);
  }
}
