// =============================================
// GET /api/verify-payment?id=PAYMENT_ID&status=paid
// Called by Moyasar after user pays (redirect callback)
// Verifies payment, updates DB, sends emails, redirects to site
// =============================================

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// Send email via Resend
async function sendEmail({ to, subject, html }) {
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
    return data;
  } catch (err) {
    console.error('Email send failed:', err);
  }
}

// Email templates
function listingActivatedEmail({ owner_name, title, listing_id, site_url }) {
  return {
    subject: `✅ فكرتك "${title}" أصبحت مباشرة على خشير`,
    html: `
      <div dir="rtl" style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #0d0d0d; color: #fff; padding: 40px; border-radius: 12px;">
        <div style="text-align: center; margin-bottom: 30px;">
          <h1 style="color: #a855f7; font-size: 2rem; margin: 0;">خشير</h1>
          <p style="color: #666; margin: 5px 0;">المنصة الذكية لشراكات حقيقية</p>
        </div>

        <h2 style="color: #22c55e;">🎉 تهانينا! فكرتك مباشرة الآن</h2>
        <p>مرحباً ${owner_name}،</p>
        <p>تم نشر فكرتك "<strong>${title}</strong>" بنجاح على منصة خشير وأصبحت ظاهرة للمهتمين.</p>

        <div style="background: #1a1a2e; padding: 20px; border-radius: 8px; border-right: 4px solid #a855f7; margin: 20px 0;">
          <p style="margin: 0; font-size: 1.1rem;">💡 <strong>كيف يعمل النظام؟</strong></p>
          <ul style="color: #ccc; line-height: 2;">
            <li>كل شخص مهتم يدفع <strong>25 ريال</strong> للحصول على بياناتك</li>
            <li>تكسب <strong>5 ريال</strong> عن كل شخص مهتم</li>
            <li>بعد <strong>20 مهتم</strong> تسترد رسوم النشر كاملة</li>
          </ul>
        </div>

        <p style="color: #888;">سنرسل لك إشعاراً فور اهتمام أي شخص بفكرتك.</p>

        <div style="text-align: center; margin-top: 30px;">
          <a href="${site_url}" style="background: linear-gradient(135deg, #a855f7, #ec4899); color: white; padding: 12px 30px; border-radius: 8px; text-decoration: none; font-weight: bold;">زيارة الموقع</a>
        </div>

        <p style="color: #444; font-size: 0.8rem; text-align: center; margin-top: 30px;">خشير — فكرتك تستحق شريكاً حقيقياً</p>
      </div>
    `
  };
}

function newInterestEmail({ owner_name, owner_email, listing_title, interest_count, earn_balance, unlocker_name, unlocker_phone, unlocker_email_addr }) {
  return {
    subject: `🔔 شخص جديد مهتم بفكرتك على خشير +5 ريال`,
    html: `
      <div dir="rtl" style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #0d0d0d; color: #fff; padding: 40px; border-radius: 12px;">
        <div style="text-align: center; margin-bottom: 20px;">
          <h1 style="color: #a855f7;">خشير</h1>
        </div>

        <h2 style="color: #22c55e;">🎉 شخص جديد مهتم بفكرتك!</h2>
        <p>مرحباً ${owner_name}،</p>
        <p>قام شخص بفتح بياناتك من فكرة "<strong>${listing_title}</strong>" ودفع 25 ريال للتواصل معك.</p>

        <div style="background: #1a1a2e; padding: 20px; border-radius: 8px; margin: 20px 0;">
          <p style="color: #a855f7; margin: 0 0 10px; font-weight: bold;">📞 بيانات المهتم:</p>
          <p style="margin: 5px 0;">الاسم: <strong>${unlocker_name}</strong></p>
          <p style="margin: 5px 0;">الجوال: <strong>${unlocker_phone}</strong></p>
          <p style="margin: 5px 0;">البريد: <strong>${unlocker_email_addr}</strong></p>
        </div>

        <div style="background: #0d2d0d; padding: 15px; border-radius: 8px; border-right: 4px solid #22c55e; margin: 20px 0;">
          <p style="color: #22c55e; margin: 0; font-size: 1.1rem;">
            ✅ رصيدك الحالي: <strong>${earn_balance} ريال</strong> من ${interest_count} مهتم
          </p>
        </div>

        <p style="color: #888;">نصيحة: تواصل مع المهتم خلال 24 ساعة لزيادة فرص الشراكة.</p>

        <p style="color: #444; font-size: 0.8rem; text-align: center; margin-top: 30px;">خشير — المنصة الذكية لشراكات حقيقية</p>
      </div>
    `
  };
}

function contactRevealedEmail({ unlocker_name, listing_title, owner_name, owner_whatsapp, owner_email_addr }) {
  const waLink = `https://wa.me/${owner_whatsapp.replace(/\D/g, '')}`;
  return {
    subject: `✅ تم فتح بيانات صاحب الفكرة — ${listing_title}`,
    html: `
      <div dir="rtl" style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #0d0d0d; color: #fff; padding: 40px; border-radius: 12px;">
        <div style="text-align: center; margin-bottom: 20px;">
          <h1 style="color: #a855f7;">خشير</h1>
        </div>

        <h2 style="color: #22c55e;">🔓 تم فتح بيانات التواصل</h2>
        <p>مرحباً ${unlocker_name}،</p>
        <p>شكراً لاهتمامك بفكرة "<strong>${listing_title}</strong>". هذه بيانات صاحب الفكرة:</p>

        <div style="background: #1a1a2e; padding: 25px; border-radius: 8px; border: 2px solid #a855f7; margin: 20px 0; text-align: center;">
          <p style="font-size: 1.3rem; margin: 0 0 5px;"><strong>${owner_name}</strong></p>
          <p style="color: #22c55e; margin: 5px 0; font-size: 1.1rem;">📱 ${owner_whatsapp}</p>
          <p style="color: #888; margin: 5px 0;">${owner_email_addr}</p>
        </div>

        <div style="text-align: center; margin: 25px 0;">
          <a href="${waLink}" style="background: #25D366; color: white; padding: 14px 35px; border-radius: 8px; text-decoration: none; font-weight: bold; font-size: 1.1rem; display: inline-block;">
            💬 تواصل عبر واتساب الآن
          </a>
        </div>

        <div style="background: #1a1a0d; padding: 15px; border-radius: 8px; margin: 20px 0;">
          <p style="color: #fbbf24; margin: 0; font-size: 0.9rem;">
            ⚠️ تنبيه: خشير منصة ربط فقط. أي اتفاقية شراكة تتم خارج المنصة وعلى مسؤولية الطرفين.
          </p>
        </div>

        <p style="color: #444; font-size: 0.8rem; text-align: center; margin-top: 30px;">خشير — المنصة الذكية لشراكات حقيقية</p>
      </div>
    `
  };
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const { id: paymentId, status } = req.query;
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || `https://${req.headers.host}`;

  if (!paymentId) {
    return res.redirect(`${siteUrl}/?error=no_payment_id`);
  }

  try {
    // 1. Verify payment with Moyasar API
    const moyasarRes = await fetch(`https://api.moyasar.com/v1/payments/${paymentId}`, {
      headers: {
        'Authorization': 'Basic ' + Buffer.from(process.env.MOYASAR_SECRET_KEY + ':').toString('base64')
      }
    });

    const payment = await moyasarRes.json();

    if (!moyasarRes.ok) {
      console.error('Moyasar verify error:', payment);
      return res.redirect(`${siteUrl}/?error=payment_verify_failed`);
    }

    if (payment.status !== 'paid') {
      return res.redirect(`${siteUrl}/?error=payment_not_paid&status=${payment.status}`);
    }

    const meta = payment.metadata || {};
    const type = meta.type;

    // 2. Check if already processed (idempotency)
    const { data: existing } = await supabase
      .from('transactions')
      .select('status')
      .eq('payment_id', paymentId)
      .single();

    if (existing?.status === 'paid') {
      // Already processed — just redirect to success
      if (type === 'listing') {
        return res.redirect(`${siteUrl}/?success=listing&already=true`);
      } else {
        return res.redirect(`${siteUrl}/?success=unlock&already=true`);
      }
    }

    // 3. Update transaction status
    await supabase
      .from('transactions')
      .update({ status: 'paid' })
      .eq('payment_id', paymentId);

    // =============================================
    // LISTING PAYMENT
    // =============================================
    if (type === 'listing') {
      const listingId = meta.listing_id;
      const ownerEmail = meta.owner_email;
      const ownerName = meta.owner_name;

      // Activate listing
      const { data: listing } = await supabase
        .from('listings')
        .update({
          status: 'active',
          listing_payment_id: paymentId
        })
        .eq('id', listingId)
        .select()
        .single();

      if (!listing) {
        console.error('Listing not found:', listingId);
        return res.redirect(`${siteUrl}/?error=listing_not_found`);
      }

      // Send activation email to owner
      const emailTemplate = listingActivatedEmail({
        owner_name: ownerName || listing.owner_name,
        title: listing.title,
        listing_id: listingId,
        site_url: siteUrl
      });

      await sendEmail({
        to: ownerEmail || listing.owner_email,
        ...emailTemplate
      });

      return res.redirect(`${siteUrl}/?success=listing&id=${listingId}`);
    }

    // =============================================
    // UNLOCK PAYMENT
    // =============================================
    if (type === 'unlock') {
      const unlockId = meta.unlock_id;
      const listingId = meta.listing_id;
      const unlockerEmail = meta.unlocker_email;
      const unlockerName = meta.unlocker_name;
      const unlockerPhone = meta.unlocker_phone;

      // 1. Mark unlock as paid
      await supabase
        .from('unlocks')
        .update({ status: 'paid', payment_id: paymentId })
        .eq('id', unlockId);

      // 2. Get listing with owner contact info
      const { data: listing } = await supabase
        .from('listings')
        .select('*')
        .eq('id', listingId)
        .single();

      if (!listing) {
        return res.redirect(`${siteUrl}/?error=listing_not_found`);
      }

      // 3. Increment interest count and earn balance
      const newInterestCount = (listing.interest_count || 0) + 1;
      const newEarnBalance = (listing.earn_balance || 0) + 5;

      await supabase
        .from('listings')
        .update({
          interest_count: newInterestCount,
          earn_balance: newEarnBalance
        })
        .eq('id', listingId);

      // 4. Send email to unlocker with contact info
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

      // 5. Send notification email to listing owner
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

      // 6. Redirect with contact info in URL (for immediate display)
      const contact = encodeURIComponent(JSON.stringify({
        name: listing.owner_name,
        whatsapp: listing.owner_whatsapp,
        email: listing.owner_email
      }));

      return res.redirect(`${siteUrl}/?success=unlock&contact=${contact}`);
    }

    // Unknown type
    return res.redirect(`${siteUrl}/?error=unknown_payment_type`);

  } catch (err) {
    console.error('Verify payment error:', err);
    return res.redirect(`${siteUrl}/?error=server_error`);
  }
}
