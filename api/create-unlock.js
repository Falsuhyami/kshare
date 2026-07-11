// =============================================
// POST /api/create-unlock
// Creates unlock record and initiates 25 SAR payment
// =============================================

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

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

    // 4. Create Moyasar payment
    const baseUrl = process.env.NEXT_PUBLIC_SITE_URL || `https://${req.headers.host}`;

    const moyasarRes = await fetch('https://api.moyasar.com/v1/payments', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Basic ' + Buffer.from(process.env.MOYASAR_SECRET_KEY + ':').toString('base64')
      },
      body: JSON.stringify({
        amount: 2500, // 25 SAR in halalas
        currency: 'SAR',
        description: `فتح بيانات تواصل: ${listing.title.substring(0, 40)}`,
        callback_url: `${baseUrl}/api/verify-payment`,
        metadata: {
          type: 'unlock',
          listing_id: listing.id,
          unlock_id: unlock.id,
          unlocker_email: unlocker_email.trim().toLowerCase(),
          unlocker_name: unlocker_name.trim(),
          unlocker_phone: unlocker_phone.trim()
        },
        source: {
          type: 'creditcard'
        }
      })
    });

    const payment = await moyasarRes.json();

    if (!moyasarRes.ok || !payment.id) {
      // Cleanup
      await supabase.from('unlocks').delete().eq('id', unlock.id);
      console.error('Moyasar error:', payment);
      return res.status(500).json({ error: 'Payment creation failed' });
    }

    // 5. Update unlock with payment ID
    await supabase
      .from('unlocks')
      .update({ payment_id: payment.id })
      .eq('id', unlock.id);

    // 6. Store transaction
    await supabase.from('transactions').insert({
      type: 'unlock',
      reference_id: unlock.id,
      amount: 25,
      payment_id: payment.id,
      status: 'pending',
      metadata: { listing_id, unlocker_email }
    });

    return res.status(200).json({
      success: true,
      payment_url: payment.source?.transaction_url,
      payment_id: payment.id,
      unlock_id: unlock.id
    });

  } catch (err) {
    console.error('Error:', err);
    return res.status(500).json({ error: err.message });
  }
}
