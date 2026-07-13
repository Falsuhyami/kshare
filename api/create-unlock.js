// =============================================
// POST /api/create-unlock
// Creates unlock record and initiates 25 SAR MyFatoorah payment
// =============================================

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// Production: https://api.myfatoorah.com
// Testing:    https://apitest.myfatoorah.com
const MF_BASE = 'https://api.myfatoorah.com';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { listing_id, unlocker_name, unlocker_email, unlocker_phone } = req.body;

  if (!listing_id || !unlocker_name || !unlocker_email || !unlocker_phone) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    // 1. Verify listing exists and is active
    const { data: listing, error: listingError } = await supabase
      .from('listings')
      .select('id, title, status, owner_name')
      .eq('id', listing_id)
      .eq('status', 'active')
      .single();

    if (listingError || !listing) {
      return res.status(404).json({ error: 'Listing not found or not active' });
    }

    // 2. Check if this email already unlocked this listing
    const { data: existingUnlock } = await supabase
      .from('unlocks')
      .select('id, status')
      .eq('listing_id', listing_id)
      .eq('unlocker_email', unlocker_email.toLowerCase())
      .eq('status', 'paid')
      .single();

    if (existingUnlock) {
      return res.status(409).json({
        error: 'already_unlocked',
        message: 'لقد سبق لك فتح بيانات هذه الفكرة'
      });
    }

    // 3. Create unlock record (pending)
    const { data: unlock, error: unlockError } = await supabase
      .from('unlocks')
      .insert({
        listing_id,
        unlocker_name: unlocker_name.trim(),
        unlocker_email: unlocker_email.trim().toLowerCase(),
        unlocker_phone: unlocker_phone.trim(),
        amount: 25,
        status: 'pending'
      })
      .select()
      .single();

    if (unlockError) {
      return res.status(500).json({ error: 'DB error: ' + unlockError.message });
    }

    // 4. Normalize phone for MyFatoorah (9 digits, no country code or leading 0)
    const phoneClean = unlocker_phone.trim().replace(/\s/g, '');
    const mobileNumber = phoneClean.replace(/^(\+966|0)/, '').replace(/\D/g, '') || '500000000';

    const baseUrl = process.env.NEXT_PUBLIC_SITE_URL || `https://${req.headers.host}`;

    const mfPayload = {
      CustomerName: unlocker_name.trim(),
      NotificationOption: 'LNK',
      InvoiceValue: 25,
      CallBackUrl: `${baseUrl}/api/verify-payment`,
      ErrorUrl: `${baseUrl}/?error=payment_failed`,
      Language: 'ar',
      CustomerEmail: unlocker_email.trim().toLowerCase(),
      DisplayCurrencyIso: 'SAR',
      MobileCountryCode: '966',
      CustomerMobile: mobileNumber,
      UserDefinedField: JSON.stringify({
        type: 'unlock',
        listing_id: listing.id,
        unlock_id: unlock.id,
        unlocker_email: unlocker_email.trim().toLowerCase(),
        unlocker_name: unlocker_name.trim(),
        unlocker_phone: unlocker_phone.trim()
      }),
      InvoiceItems: [{
        ItemName: `فتح بيانات تواصل: ${listing.title.substring(0, 40)}`,
        Quantity: 1,
        UnitPrice: 25
      }]
    };

    const mfRes = await fetch(`${MF_BASE}/v2/SendPayment`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.MYFATOORAH_API_KEY}`
      },
      body: JSON.stringify(mfPayload)
    });

    const mfData = await mfRes.json();

    if (!mfRes.ok || !mfData.IsSuccess) {
      // Cleanup pending unlock
      await supabase.from('unlocks').delete().eq('id', unlock.id);
      console.error('MyFatoorah error:', JSON.stringify(mfData));
      return res.status(500).json({
        error: 'Payment creation failed',
        details: mfData.Message || JSON.stringify(mfData.ValidationErrors) || 'Unknown error'
      });
    }

    const invoiceId = String(mfData.Data.InvoiceId);
    const paymentUrl = mfData.Data.PaymentURL;

    // 5. Update unlock with invoice ID
    await supabase
      .from('unlocks')
      .update({ payment_id: invoiceId })
      .eq('id', unlock.id);

    // 6. Store transaction
    await supabase.from('transactions').insert({
      type: 'unlock',
      reference_id: unlock.id,
      amount: 25,
      payment_id: invoiceId,
      status: 'pending',
      metadata: { listing_id, unlocker_email }
    });

    return res.status(200).json({
      success: true,
      payment_url: paymentUrl,
      payment_id: invoiceId,
      unlock_id: unlock.id
    });

  } catch (err) {
    console.error('Error:', err);
    return res.status(500).json({ error: err.message });
  }
}
