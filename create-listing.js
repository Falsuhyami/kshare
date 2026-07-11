// =============================================
// POST /api/create-listing
// Creates a new listing and initiates Moyasar payment
// =============================================

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

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

  // Basic email validation
  if (!owner_email.includes('@')) {
    return res.status(400).json({ error: 'Invalid email' });
  }

  // WhatsApp must start with +966 or 05
  const phone = owner_whatsapp.replace(/\s/g, '');
  if (!phone.match(/^(\+966|0)(5\d{8})$/)) {
    return res.status(400).json({ error: 'Invalid WhatsApp number (use +966 or 05xxxxxxxx)' });
  }

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

    // 2. Create Moyasar payment
    const baseUrl = process.env.NEXT_PUBLIC_SITE_URL || `https://${req.headers.host}`;

    const moyasarPayload = {
      amount: 9900, // 99 SAR in halalas
      currency: 'SAR',
      description: `نشر فكرة على خشير: ${title.substring(0, 50)}`,
      callback_url: `${baseUrl}/api/verify-payment`,
      publishable_api_key: process.env.MOYASAR_PUBLISHABLE_KEY,
      metadata: {
        type: 'listing',
        listing_id: listing.id,
        owner_email: owner_email.trim().toLowerCase(),
        owner_name: owner_name.trim()
      },
      source: {
        type: 'creditcard'
      }
    };

    const moyasarRes = await fetch('https://api.moyasar.com/v1/payments', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Basic ' + Buffer.from(process.env.MOYASAR_SECRET_KEY + ':').toString('base64')
      },
      body: JSON.stringify(moyasarPayload)
    });

    const payment = await moyasarRes.json();

    if (!moyasarRes.ok || !payment.id) {
      // Clean up the listing if payment creation failed
      await supabase.from('listings').delete().eq('id', listing.id);
      console.error('Moyasar Error:', payment);
      return res.status(500).json({ error: 'Payment creation failed', details: payment.message || 'Unknown error' });
    }

    // 3. Store payment ID in listing
    await supabase
      .from('listings')
      .update({ listing_payment_id: payment.id })
      .eq('id', listing.id);

    // 4. Store transaction record
    await supabase.from('transactions').insert({
      type: 'listing',
      reference_id: listing.id,
      amount: 99,
      payment_id: payment.id,
      status: 'pending',
      metadata: { owner_email, listing_title: title }
    });

    // 5. Return payment URL to frontend
    const paymentUrl = payment.source?.transaction_url;
    if (!paymentUrl) {
      await supabase.from('listings').delete().eq('id', listing.id);
      return res.status(500).json({ error: 'No payment URL returned from Moyasar' });
    }

    return res.status(200).json({
      success: true,
      payment_url: paymentUrl,
      payment_id: payment.id,
      listing_id: listing.id
    });

  } catch (err) {
    console.error('Unexpected error:', err);
    return res.status(500).json({ error: 'Server error: ' + err.message });
  }
}
