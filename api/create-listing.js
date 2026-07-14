// =============================================
// POST /api/create-listing
// Creates a new listing and initiates Moyasar payment (50 SAR)
// =============================================

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const MOYASAR_BASE = 'https://api.moyasar.com/v1';

function moyasarAuth() {
  return 'Basic ' + Buffer.from(process.env.MOYASAR_API_KEY + ':').toString('base64');
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const {
    title, description, category, budget_range, timeline, expected_partner,
    owner_name, owner_email, owner_whatsapp, location,
    project_type, monthly_revenue, monthly_expenses
  } = req.body;

  if (!title || !description || !owner_name || !owner_email || !owner_whatsapp) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  if (!owner_email.includes('@')) {
    return res.status(400).json({ error: 'Invalid email' });
  }

  const phone = owner_whatsapp.replace(/\s/g, '');
  if (!phone.match(/^(\+966|0)(5\d{8})$/)) {
    return res.status(400).json({ error: 'Invalid WhatsApp number (use +966 or 05xxxxxxxx)' });
  }

  if (!process.env.MOYASAR_API_KEY) {
    return res.status(500).json({ error: 'MOYASAR_API_KEY is not set in environment variables' });
  }

  try {
    // 1. Create listing in Supabase (pending_payment)
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
        project_type: project_type || 'فكرة',
        monthly_revenue: monthly_revenue ? parseFloat(monthly_revenue) : null,
        monthly_expenses: monthly_expenses ? parseFloat(monthly_expenses) : null,
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
      amount: 5000,           // 50 SAR in halalas
      currency: 'SAR',
      description: `نشر مشروع على خشير: ${title.trim().substring(0, 60)}`,
      metadata: {
        type: 'listing',
        listing_id: listing.id,
        owner_email: owner_email.trim().toLowerCase(),
        owner_name: owner_name.trim()
      },
      source: {
        type: 'creditcard',
        back_url: `${baseUrl}/api/verify-payment`
      }
    };

    const mRes = await fetch(`${MOYASAR_BASE}/payments`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': moyasarAuth()
      },
      body: JSON.stringify(moyasarPayload)
    });

    // Safe parse
    const mText = await mRes.text();
    let mData;
    try {
      mData = JSON.parse(mText);
    } catch (parseErr) {
      console.error('Moyasar non-JSON response. Status:', mRes.status, 'Body:', mText);
      await supabase.from('listings').delete().eq('id', listing.id);
      return res.status(500).json({
        error: 'Moyasar API error',
        details: `HTTP ${mRes.status} — ${mText || 'Empty response. Check MOYASAR_API_KEY.'}`
      });
    }

    if (!mRes.ok || mData.errors) {
      await supabase.from('listings').delete().eq('id', listing.id);
      console.error('Moyasar Error:', JSON.stringify(mData));
      return res.status(500).json({
        error: 'Payment creation failed',
        details: mData.message || JSON.stringify(mData.errors) || 'Unknown error'
      });
    }

    const paymentId = mData.id;
    const paymentUrl = mData.source?.transaction_url;

    if (!paymentUrl) {
      await supabase.from('listings').delete().eq('id', listing.id);
      return res.status(500).json({ error: 'No payment URL returned from Moyasar' });
    }

    // 3. Store payment ID in listing
    await supabase
      .from('listings')
      .update({ listing_payment_id: paymentId })
      .eq('id', listing.id);

    // 4. Store transaction record
    await supabase.from('transactions').insert({
      type: 'listing',
      reference_id: listing.id,
      amount: 50,
      payment_id: paymentId,
      status: 'pending',
      metadata: { owner_email: owner_email.trim().toLowerCase(), listing_title: title }
    });

    return res.status(200).json({
      success: true,
      payment_url: paymentUrl,
      payment_id: paymentId,
      listing_id: listing.id
    });

  } catch (err) {
    console.error('Unexpected error:', err);
    return res.status(500).json({ error: 'Server error: ' + err.message });
  }
}
