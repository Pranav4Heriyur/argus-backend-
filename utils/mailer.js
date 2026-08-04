// utils/mailer.js
// Sends password-reset emails.
//
// If SMTP_USER / SMTP_PASS are set in .env, sends via Gmail for real.
//
// If they're NOT set, automatically creates a free Ethereal test inbox
// (https://ethereal.email) - no signup needed - and sends the email there.
// Ethereal doesn't deliver to a real inbox, but it gives you a link to view
// the actual rendered email in your browser, so you can see the real
// "email experience" without configuring anything.

const nodemailer = require("nodemailer");

let transporter = null;
let usingEthereal = false;
let etherealAccountPromise = null;

async function getTransporter() {
  if (transporter) return transporter;

  if (process.env.SMTP_USER && process.env.SMTP_PASS) {
    transporter = nodemailer.createTransport({
      service: "gmail",
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS, // Gmail App Password, not your normal password
      },
    });
    usingEthereal = false;
    return transporter;
  }

  // No real SMTP configured - spin up a free Ethereal test account.
  if (!etherealAccountPromise) {
    etherealAccountPromise = nodemailer.createTestAccount();
  }
  const testAccount = await etherealAccountPromise;

  transporter = nodemailer.createTransport({
    host: "smtp.ethereal.email",
    port: 587,
    secure: false,
    auth: {
      user: testAccount.user,
      pass: testAccount.pass,
    },
  });
  usingEthereal = true;
  return transporter;
}

async function sendResetEmail(to, resetUrl) {
  const subject = "Reset your Argus password";
  const text =
    "We received a request to reset your Argus password.\n\n" +
    "Click the link below to choose a new password. This link expires in 30 minutes.\n\n" +
    resetUrl +
    "\n\nIf you didn't request this, you can ignore this email.";
  const html =
    `<p>We received a request to reset your Argus password.</p>` +
    `<p><a href="${resetUrl}">Click here to choose a new password</a>. This link expires in 30 minutes.</p>` +
    `<p>If you didn't request this, you can ignore this email.</p>`;

  try {
    const t = await getTransporter();
    const info = await t.sendMail({
      from: process.env.MAIL_FROM || (usingEthereal ? "Argus <no-reply@argus.school>" : process.env.SMTP_USER),
      to,
      subject,
      text,
      html,
    });

    if (usingEthereal) {
      const previewUrl = nodemailer.getTestMessageUrl(info);
      console.log("\n[mailer] No SMTP configured - using a free Ethereal test inbox (not a real delivery).");
      console.log("[mailer] Open this link to view the actual email exactly as a parent would see it:");
      console.log("[mailer]", previewUrl, "\n");
      return { delivered: false, previewUrl };
    }

    return { delivered: true };
  } catch (err) {
    // Ethereal (or Gmail) unreachable - fall back to printing the raw
    // reset link so the flow still works even with no working mail path.
    console.log("\n[mailer] Could not send via email (", err.message, ").");
    console.log("[mailer] Reset link for", to, ":\n", resetUrl, "\n");
    return { delivered: false };
  }
}

module.exports = { sendResetEmail };
