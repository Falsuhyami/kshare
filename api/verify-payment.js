// =============================================
// GET /api/verify-payment
// Moyasar callback — called after payment with ?id=PAYMENT_ID&status=paid
// Verifies payment server-side, updates DB, sends emails, redirects to site
// SECURITY: Contact info is stored behind a one-time UUID token
// =============================================

import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'crypto';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const MOYASAR_BASE = 'https://api.moyasar.com/v1';

function moyasarAuth() {
  return 'Basic ' + Buffer.from(process.env.MOYASAR_API_KEY + ':').toString('base64');
}

// ──────────────────────────────────────────────────────────────────────────────
// Email helper (Resend)
// ──────────────────────────────────────────────────────────────────────────────
async function sendEmail({ to, subject, html }) {
  if (!process.env.RESEND_API_KEY) return; // skip if not configured
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: 'خشير <noreply@kshare.sa>',
        to,
        subject,
        html
      })
    });
    const data = await res.json();
    if (!res.ok) console.error('Resend error:', data);
  } catch (err) {
    console.error('Email send failed:', err);
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Email templates
// ──────────────────────────────────────────────────────────────────────────────
function listingActivatedEmail({ owner_name, title, site_url }) {
  return {
    subject: `✅ مشروعك "${title}" أصبح مباشراً على خشير`,
    html: `
      <div dir="rtl" style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #f7faf5; color: #14231a; padding: 40px; border-radius: 12px; border: 1px solid #dcfce7;">
        <div style="text-align: center; margin-bottom: 30px;">
          <h1 style="color: #16a34a; font-size: 2rem; margin: 0;">خشير</h1>
          <p style="color: #52735c; margin: 5px 0;">منصة المشاريع والشراكات السعودية</p>
        </div>
        <h2 style="color: #15803d;">🎉 تهانينا! مشروعك مباشر الآن</h2>
        <p>مرحباً ${owner_name}،</p>
        <p>تم نشر مشروعك "<strong>${title}</strong>" بنجاح على منصة خشير وأصبح ظاهراً للمهتمين.</p>
        <div style="background: #dcfce7; padding: 20px; border-radius: 8px; border-right: 4px solid #16a34a; margin: 20px 0;">
          <p style="margin: 0 0 10px; font-size: 1.1rem; color: #15803d;">💡 <strong>كيف يعمل النظام؟</strong></p>
          <ul style="color: #14231a; line-height: 2; margin: 0; padding-right: 20px;">
            <li>كل شخص مهتم يدفع <strong>25 ريال</strong> للحصول على بياناتك</li>
            <li>تكسب <strong>5 ريال</strong> عن كل شخص مهتم</li>
            <li>بعد <strong>10 مهتمين</strong> تسترد رسوم النشر كاملة</li>
          </ul>
        </div>
        <p style="color: #52735c;">سنرسل لك إشعاراً فور اهتمام أي شخص بمشروعك.</p>
        <div style="text-align: center; margin-top: 30px;">
          <a href="${site_url}" style="background: #16a34a; color: white; padding: 14px 32px; border-radius: 8px; text-decoration: none; font-weight: bold; font-size: 1rem;">زيارة خشير</a>
        </div>
        <p style="color: #52735c; font-size: 0.8rem; text-align: center; margin-top: 30px;">خشير — مشروعك يستحق شريكاً حقيقياً</p>
      </div>
    `
  };
}

function newInterestEmail({ owner_name, listing_title, interest_count, earn_balance, unlocker_name, unlocker_phone, unlocker_email_addr }) {
  return {
    subject: `🔔 شخص جديد مهتم بمشروعك على خشير — كسبت 5 ريال`,
    html: `
      <div dir="rtl" style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #f7faf5; color: #14231a; padding: 40px; border-radius: 12px; border: 1px solid #dcfce7;">
        <div style="text-align: center; margin-bottom: 20px;">
          <h1 style="color: #16a34a; margin: 0;">خشير</h1>
          <p style="color: #52735c; margin: 4px 0 0;">منصة المشاريع والشراكات السعودية</p>
        </div>
        <h2 style="color: #15803d;">🎉 شخص جديد مهتم بمشروعك!</h2>
        <p>مرحباً ${owner_name}،</p>
        <p>قام شخص بفتح بياناتك من مشروع "<strong>${listing_title}</strong>" ودفع 25 ريال للتواصل معك.</p>
        <div style="background: #fff; border: 1px solid #dcfce7; padding: 20px; border-radius: 8px; margin: 20px 0;">
          <p style="color: #15803d; margin: 0 0 12px; font-weight: bold;">📞 بيانات المهتم:</p>
          <p style="margin: 6px 0;">الاسم: <strong>${unlocker_name}</strong></p>
          <p style="margin: 6px 0;">الجوال: <strong>${unlocker_phone}</strong></p>
          <p style="margin: 6px 0;">البريد: <strong>${unlocker_email_addr}</strong></p>
        </div>
        <div style="background: #dcfce7; padding: 15px; border-radius: 8px; border-right: 4px solid #16a34a; margin: 20px 0;">
          <p style="color: #15803d; margin: 0; font-size: 1.1rem; font-weight: bold;">
            ✅ رصيدك الحالي: ${earn_balance} ريال من ${interest_count} مهتم
          </p>
        </div>
        <p style="color: #52735c;">نصيحة: تواصل مع المهتم خلال 24 ساعة لزيادة فرص الشراكة.</p>
        <p style="color: #52735c; font-size: 0.8rem; text-align: center; margin-top: 30px;">خشير — منصة المشاريع والشراكات السعودية</p>
      </div>
    `
  };
}

function contactRevealedEmail({ unlocker_name, listing_title, owner_name, owner_whatsapp, owner_email_addr }) {
  const waLink = `https://wa.me/${(owner_whatsapp || '').replace(/\D/g, '')}`;
  return {
    subject: `✅ تم فتح بيانات صاحب المشروع — ${listing_title}`,
    html: `
      <div dir="rtl" style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #f7faf5; color: #14231a; padding: 40px; border-radius: 12px; border: 1px solid #dcfce7;">
        <div style="text-align: center; margin-bottom: 20px;">
          <h1 style="color: #16a34a; margin: 0;">خشير</h1>
          <p style="color: #52735c; margin: 4px 0 0;">منصة المشاريع والشراكات السعودية</p>
        </div>
        <h2 style="color: #15803d;">🔓 تم فتح بيانات التواصل</h2>
        <p>مرحباً ${unlocker_name}،</p>
        <p>شكراً لاهتمامك بمشروع "<strong>${listing_title}</strong>". هذه بيانات صاحب المشروع:</p>
        <div style="background: #fff; padding: 25px; border-radius: 8px; border: 2px solid #16a34a; margin: 20px 0; text-align: center;">
          <p style="font-size: 1.3rem; margin: 0 0 8px; color: #14231a;"><strong>${owner_name}</strong></p>
          <p style="color: #16a34a; margin: 6px 0; font-size: 1.1rem; font-weight: bold;">📱 ${owner_whatsapp}</p>
          <p style="color: #52735c; margin: 6px 0;">${owner_email_addr}</p>
        </div>
        <div style="text-align: center; margin: 25px 0;">
          <a href="${waLink}" style="background: #25D366; color: white; padding: 14px 35px; border-radius: 8px; text-decoration: none; font-weight: bold; font-size: 1.05rem; display: inline-block;">
            💬 تواصل عبر واتساب الآن
          </a>
        </div>
        <div style="background: #fef3c7; padding: 15px; border-radius: 8px; border-right: 4px solid #d97706; margin: 20px 0;">
          <p style="color: #92400e; margin: 0; font-size: 0.9rem;">
            تنبيه: خشير منصة ربط فقط. أي اتفاقية شراكة تتم خارج المنصة وعلى مسؤولية الطرفين.
          </p>
        </div>
        <p style="color: #52735c; font-size: 0.8rem; text-align: center; margin-top: 30px;">خشير — منصة المشاريع والشراكات السعودية</p>
      </div>
    `
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Main handler
// ──────────────────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  // Moyasar sends: ?id=PAYMENT_ID&status=paid (or failed/canceled)
  const { id: paymentId, status: callbackStatus } = req.query;
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || `https://${req.headers.host}`;

  if (!paymentId) {
    console.error('No payment ID in Moyasar callback');
    return res.redirect(`${siteUrl}/?error=no_payment_id`);
  }

  try {
    // 1. Verify payment with Moyasar (always server-side — don't trust callback params)
    const mRes = await fetch(`${MOYASAR_BASE}/payments/${paymentId}`, {
      method: 'GET',
      headers: {
        'Authorization': moyasarAuth()
      }
    });

    const mText = await mRes.text();
    let payment;
    try {
      payment = JSON.parse(mText);
    } catch (parseErr) {
      console.error('Moyasar verify non-JSON. Status:', mRes.status, 'Body:', mText);
      return res.redirect(`${siteUrl}/?error=payment_verify_failed`);
    }

    if (!mRes.ok || payment.errors) {
      console.error('Moyasar verify error:', JSON.stringify(payment));
      return res.redirect(`${siteUrl}/?error=payment_verify_failed`);
    }

    // 2. Check actual payment status
    if (payment.status !== 'paid') {
      console.log(`Payment ${paymentId} status: ${payment.status}`);
      return res.redirect(`${siteUrl}/?error=payment_not_completed&status=${payment.status}`);
    }

    // 3. Read metadata
    const meta = payment.metadata || {};
    const type = meta.type;

    if (!type) {
      console.error('No type in payment metadata:', JSON.stringify(meta));
      return res.redirect(`${siteUrl}/?error=missing_metadata`);
    }

    // 4. Idempotency — check if already processed
    const { data: existing } = await supabase
      .from('transactions')
      .select('status')
      .eq('payment_id', paymentId)
      .single();

    if (existing?.status === 'paid') {
      // Already processed — redirect silently
      return res.redirect(`${siteUrl}/?${type === 'listing' ? 'success=listing&already=true' : 'error=already_processed'}`);
    }

    // 5. Mark transaction as paid
    await supabase
      .from('transactions')
      .update({ status: 'paid' })
      .eq('payment_id', paymentId);

    // ──────────────────────────────────────────────────────────────────────────
    // LISTING PAYMENT — activate listing
    // ──────────────────────────────────────────────────────────────────────────
    if (type === 'listing') {
      const listingId = meta.listing_id;
      const ownerEmail = meta.owner_email;
      const ownerName = meta.owner_name;

      const { data: listing } = await supabase
        .from('listings')
        .update({
          status: 'active',
          listing_payment_id: paymentId,
          activated_at: new Date().toISOString()
        })
        .eq('id', listingId)
        .select()
        .single();

      if (!listing) {
        console.error('Listing not found for ID:', listingId);
        return res.redirect(`${siteUrl}/?error=listing_not_found`);
      }

      // Send activation email
      await sendEmail({
        to: ownerEmail || listing.owner_email,
        ...listingActivatedEmail({
          owner_name: ownerName || listing.owner_name,
          title: listing.title,
          site_url: siteUrl
        })
      });

      return res.redirect(`${siteUrl}/?success=listing&id=${listingId}`);
    }

    // ──────────────────────────────────────────────────────────────────────────
    // UNLOCK PAYMENT — generate one-time contact token
    // ──────────────────────────────────────────────────────────────────────────
    if (type === 'unlock') {
      const unlockId = meta.unlock_id;
      const listingId = meta.listing_id;
      const unlockerEmail = meta.unlocker_email;
      const unlockerName = meta.unlocker_name;
      const unlockerPhone = meta.unlocker_phone;

      // Generate one-time UUID token (SECURITY: contact is behind this token, never in URL)
      const contactToken = randomUUID();

      // Mark unlock as paid + store token
      await supabase
        .from('unlocks')
        .update({
          status: 'paid',
          payment_id: paymentId,
          contact_token: contactToken,
          paid_at: new Date().toISOString()
        })
        .eq('id', unlockId);

      // Get listing with contact info
      const { data: listing } = await supabase
        .from('listings')
        .select('*')
        .eq('id', listingId)
        .single();

      if (!listing) {
        return res.redirect(`${siteUrl}/?error=listing_not_found`);
      }

      // Update listing interest count and earn balance
      const newInterestCount = (listing.interest_count || 0) + 1;
      const newEarnBalance = (listing.earn_balance || 0) + 5;

      await supabase
        .from('listings')
        .update({
          interest_count: newInterestCount,
          earn_balance: newEarnBalance
        })
        .eq('id', listingId);

      // Send contact info email to unlocker
      await sendEmail({
        to: unlockerEmail,
        ...contactRevealedEmail({
          unlocker_name: unlockerName,
          listing_title: listing.title,
          owner_name: listing.owner_name,
          owner_whatsapp: listing.owner_whatsapp,
          owner_email_addr: listing.owner_email
        })
      });

      // Send notification to listing owner (+5 SAR)
      await sendEmail({
        to: listing.owner_email,
        ...newInterestEmail({
          owner_name: listing.owner_name,
          listing_title: listing.title,
          interest_count: newInterestCount,
          earn_balance: newEarnBalance,
          unlocker_name: unlockerName,
          unlocker_phone: unlockerPhone,
          unlocker_email_addr: unlockerEmail
        })
      });

      // Record owner commission
      await supabase.from('transactions').insert({
        type: 'owner_commission',
        reference_id: listingId,
        amount: 5,
        payment_id: paymentId,
        status: 'credited',
        metadata: { unlock_id: unlockId, source: 'unlock_payment' }
      });

      // SECURE redirect — only the token goes in URL, NOT contact info
      return res.redirect(`${siteUrl}/?success=unlock&token=${contactToken}`);
    }

    // Unknown payment type
    console.error('Unknown payment type in metadata:', type);
    return res.redirect(`${siteUrl}/?error=unknown_payment_type`);

  } catch (err) {
    console.error('Verify payment error:', err);
    return res.redirect(`${siteUrl}/?error=server_error`);
  }
}
