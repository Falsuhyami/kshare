// =============================================
// GET /api/get-contact?token=UUID
// One-time secure contact retrieval after unlock payment
// Token is nullified after a single use
// =============================================

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const { token } = req.query;

  if (!token) {
    return res.status(400).json({ error: 'Missing token' });
  }

  // UUID format sanity check
  const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (!UUID_REGEX.test(token)) {
    return res.status(400).json({ error: 'Invalid token format' });
  }

  try {
    // 1. Look up unlock by token (must be paid and token must not be null)
    const { data: unlock, error: unlockError } = await supabase
      .from('unlocks')
      .select('id, listing_id')
      .eq('contact_token', token)
      .eq('status', 'paid')
      .single();

    if (unlockError || !unlock) {
      return res.status(404).json({ error: 'Token invalid or already used' });
    }

    // 2. Get listing contact info (using service_role — bypasses RLS to read private columns)
    const { data: listing, error: listingError } = await supabase
      .from('listings')
      .select('title, owner_name, owner_email, owner_whatsapp, project_type')
      .eq('id', unlock.listing_id)
      .single();

    if (listingError || !listing) {
      return res.status(404).json({ error: 'Listing not found' });
    }

    // 3. IMPORTANT: Nullify the token immediately after reading — one-time use only
    await supabase
      .from('unlocks')
      .update({ contact_token: null })
      .eq('id', unlock.id);

    // 4. Return contact info + listing context
    return res.status(200).json({
      listing_title: listing.title,
      project_type: listing.project_type,
      contact: {
        name: listing.owner_name,
        whatsapp: listing.owner_whatsapp,
        email: listing.owner_email
      }
    });

  } catch (err) {
    console.error('Get contact error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
}
