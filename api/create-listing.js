// =============================================
// POST /api/create-listing
// Creates a new listing and initiates MyFatoorah payment
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
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const {
    title, description, category, budget_range, timeline, expected_partner,
    owner_name, owner_email, owner_whatsapp, location
  } = req.body;

  // Validate required fields
  if (!title || !description || !owner_name || !owner_email || !owner_whatsapp) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  if (!owner_email.includes('@')) {
    return res.status(400).json({ error: 'Invalid email' });
  }

  // WhatsApp must start with +966 or 05
  const phone = owner_whatsapp.replace(/\s/g, '');
  if (!phone.match(/^(\+966|0)(5\d{8})$/)) {
    return res.status(400).json({ error: 'Invalid WhatsApp number (use +966 or 05xxxxxxxx)' });
  }

  // Normalize phone → 9 digits (e.g. "501234567") for MyFatoorah
  const mobileNumber = phone.replace(/^(\+966|0)/, '');

  try {
    // 1. Create listing in Supabase with pending_payment status
    const { data: listing, error: dbError } = await supabase
      .from('listings')
      .insert({
        title: title.trim(),
        description: description.trim(),
        category: category || 'تقنية',
        budget_range: budget_range || null,
        timeline: timeline || null,
        expected_partner: expected_partner || null,
        location: location || 'السعودية',
        owner_name: owner_name.trim(),
        owner_email: owner_email.trim().toLowerCase(),
        owner_whatsapp: phone,
        status: 'pending_payment'
      })
      .select()
      .single();

    if (dbError) {
      console.error('DB Error:', dbError);
      return res.status(500).json({ error: 'Database error: ' + dbError.message });
    }

    // 2. Create MyFatoorah invoice
    const baseUrl = process.env.NEXT_PUBLIC_SITE_URL || `https://${req.headers.host}`;

    const mfPayload = {
      CustomerName: owner_name.trim(),
      NotificationOption: 'LNK',           // Returns a hosted payment link
      InvoiceValue: 99,                     // SAR full amount (not halalas)
      CallBackUrl: `${baseUrl}/api/verify-payment`,
      ErrorUrl: `${baseUrl}/?error=payment_failed`,
      Language: 'ar',
      CustomerEmail: owner_email.trim().toLowerCase(),
      DisplayCurrencyIso: 'SAR',
      MobileCountryCode: '966',
      CustomerMobile: mobileNumber,
      // Metadata stored as JSON string — retrieved after payment via GetPaymentStatus
      UserDefinedField: JSON.stringify({
        type: 'listing',
        listing_id: listing.id,
        owner_email: owner_email.trim().toLowerCase(),
        owner_name: owner_name.trim()
      }),
      InvoiceItems: [{
        ItemName: `نشر فكرة على خشير: ${title.trim().substring(0, 50)}`,
        Quantity: 1,
        UnitPrice: 99
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
      // Clean up the listing if payment creation failed
      await supabase.from('listings').delete().eq('id', listing.id);
      console.error('MyFatoorah Error:', JSON.stringify(mfData));
      return res.status(500).json({
        error: 'Payment creation failed',
        details: mfData.Message || JSON.stringify(mfData.ValidationErrors) || 'Unknown error'
      });
    }

    const invoiceId = String(mfData.Data.InvoiceId);
    const paymentUrl = mfData.Data.PaymentURL;

    if (!paymentUrl) {
      await supabase.from('listings').delete().eq('id', listing.id);
      return res.status(500).json({ error: 'No payment URL returned from MyFatoorah' });
    }

    // 3. Store invoice ID in listing
    await supabase
      .from('listings')
      .update({ listing_payment_id: invoiceId })
      .eq('id', listing.id);

    // 4. Store transaction record
    await supabase.from('transactions').insert({
      type: 'listing',
      reference_id: listing.id,
      amount: 99,
      payment_id: invoiceId,
      status: 'pending',
      metadata: { owner_email, listing_title: title }
    });

    // 5. Return payment URL to frontend
    return res.status(200).json({
      success: true,
      payment_url: paymentUrl,
      payment_id: invoiceId,
      listing_id: listing.id
    });

  } catch (err) {
    console.error('Unexpected error:', err);
    return res.status(500).json({ error: 'Server error: ' + err.message });
  }
}
