// lib/supabaseClient.ts
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

// exposed for all browser‐side code
export const supabaseBrowser = createClient(
    SUPABASE_URL,
    SUPABASE_ANON_KEY
);

// only for server–side calls (eg. in app/api/…, getServerSideProps, or server Actions)
export const supabaseAdmin = createClient(
    SUPABASE_URL,
    SUPABASE_SERVICE_KEY,
    {
        // this header ensures that even if your anon key leaks, no‐one can elevate
        // their privileges—only supabaseAdmin calls will be signed with the service role
        global: {
            headers: { Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` }
        }
    }
);
