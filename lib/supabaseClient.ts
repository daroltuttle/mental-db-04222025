import { createClient } from '@supabase/supabase-js';

const supabaseUrl    = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseAnon   = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const supabaseSrvKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

export const supabase = createClient(supabaseUrl, supabaseAnon, {
  // use the service role key only in server‐side contexts
  global: { headers: { Authorization: `Bearer ${supabaseSrvKey}` } }
});
