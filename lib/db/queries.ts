// lib/db/queries.ts
import { cookies } from 'next/headers';
import { verifyToken } from '@/lib/auth/session';
import { supabaseAdmin } from '@/lib/supabaseClient';

// --- getUser: reads session cookie, verifies it, and fetches the user row ---
export async function getUser() {
    const sessionCookie = (await cookies()).get('session');
    if (!sessionCookie?.value) return null;

    const sessionData = await verifyToken(sessionCookie.value);
    if (
        !sessionData ||
        !sessionData.user ||
        typeof sessionData.user.id !== 'number' ||
        new Date(sessionData.expires) < new Date()
    ) {
        return null;
    }

    const { data: user, error } = await supabaseAdmin
        .from('users')
        .select('*')
        .eq('id', sessionData.user.id)
        .is('deleted_at', null)
        .maybeSingle();

    if (error || !user) return null;
    return user;
}

// --- getTeamByStripeCustomerId: find a team by its Stripe customer ID ---
export async function getTeamByStripeCustomerId(customerId: string) {
    const { data: team, error } = await supabaseAdmin
        .from('teams')
        .select('*')
        .eq('stripe_customer_id', customerId)
        .limit(1)
        .maybeSingle();

    return error ? null : team;
}

// --- updateTeamSubscription: update the subscription fields on a team ---
export async function updateTeamSubscription(
    teamId: number,
    subscriptionData: {
        stripeSubscriptionId: string | null;
        stripeProductId: string | null;
        planName: string | null;
        subscriptionStatus: string;
    }
) {
    const { error } = await supabaseAdmin
        .from('teams')
        .update({
            stripe_subscription_id: subscriptionData.stripeSubscriptionId,
            stripe_product_id: subscriptionData.stripeProductId,
            plan_name: subscriptionData.planName,
            subscription_status: subscriptionData.subscriptionStatus,
            updated_at: new Date().toISOString(),
        })
        .eq('id', teamId);

    if (error) throw error;
}

// --- getUserWithTeam: returns { user, teamId } for a given userId ---
export async function getUserWithTeam(userId: number) {
    // fetch the user row
    const { data: user, error: userErr } = await supabaseAdmin
        .from('users')
        .select('*')
        .eq('id', userId)
        .maybeSingle();
    if (userErr || !user) return null;

    // fetch their first team membership
    const { data: membership, error: memErr } = await supabaseAdmin
        .from('team_members')
        .select('team_id')
        .eq('user_id', userId)
        .limit(1)
        .maybeSingle();
    if (memErr) throw memErr;

    return {
        user,
        teamId: membership?.team_id ?? null,
    };
}

// --- getActivityLogs: fetch last 10 logs for the currently authenticated user ---
export async function getActivityLogs() {
    const user = await getUser();
    if (!user) throw new Error('User not authenticated');

    const { data, error } = await supabaseAdmin
        .from('activity_logs')
        .select(`
      id,
      action,
      timestamp,
      ip_address,
      users ( name )
    `)
        .eq('user_id', user.id)
        .order('timestamp', { ascending: false })
        .limit(10);

    if (error) throw error;
    // map to the shape you expect
    return data.map((row) => ({
        id: row.id,
        action: row.action,
        timestamp: row.timestamp,
        ipAddress: row.ip_address,
        userName: row.users.name,
    }));
}

// --- getTeamForUser: load the team plus its members for a given userId ---
export type TeamWithMembers = {
    id: number;
    name: string;
    stripe_customer_id: string | null;
    plan_name: string | null;
    subscription_status: string | null;
    members: Array<{
        id: number;
        name: string;
        email: string;
        role: string;
    }>;
};

export async function getTeamForUser(userId: number): Promise<TeamWithMembers | null> {
    // figure out which team they belong to
    const { data: membership, error: memErr } = await supabaseAdmin
        .from('team_members')
        .select('team_id')
        .eq('user_id', userId)
        .limit(1)
        .maybeSingle();
    if (memErr || !membership) return null;

    // load the team row itself
    const { data: team, error: teamErr } = await supabaseAdmin
        .from('teams')
        .select('*')
        .eq('id', membership.team_id)
        .maybeSingle();
    if (teamErr || !team) return null;

    // and load all members (with user info)
    const { data: members, error: membersErr } = await supabaseAdmin
        .from('team_members')
        .select('role, users(id, name, email)')
        .eq('team_id', membership.team_id);
    if (membersErr) throw membersErr;

    return {
        id: team.id,
        name: team.name,
        stripe_customer_id: team.stripe_customer_id,
        plan_name: team.plan_name,
        subscription_status: team.subscription_status,
        members: members.map((m) => ({
            id: m.users.id,
            name: m.users.name,
            email: m.users.email!,
            role: m.role,
        })),
    };
}
