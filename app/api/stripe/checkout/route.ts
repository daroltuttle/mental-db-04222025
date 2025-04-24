// app/api/stripe/checkout/route.ts
import { NextRequest, NextResponse } from 'next/server';
import Stripe from 'stripe';
import { stripe } from '@/lib/payments/stripe';
import { supabase } from '@/lib/supabaseClient';
import { setSession } from '@/lib/auth/session';

export async function GET(request: NextRequest) {
    const sessionId = request.nextUrl.searchParams.get('session_id');
    if (!sessionId) {
        return NextResponse.redirect(new URL('/pricing', request.url));
    }

    try {
        // 1️⃣ Retrieve the Stripe Checkout session
        const session = await stripe.checkout.sessions.retrieve(sessionId, {
            expand: ['customer', 'subscription'],
        });
        if (!session.customer || typeof session.customer === 'string') {
            throw new Error('Invalid customer data from Stripe.');
        }

        const customerId = session.customer.id;
        const subscription =
            typeof session.subscription === 'string'
                ? await stripe.subscriptions.retrieve(session.subscription)
                : session.subscription;
        if (!subscription) {
            throw new Error('No subscription found for this session.');
        }
        const plan = subscription.items.data[0]?.price;
        if (!plan) {
            throw new Error('No plan found for this subscription.');
        }
        const product = plan.product as Stripe.Product;
        const subscriptionId = subscription.id;

        // 2️⃣ Grab the user ID you stored in `client_reference_id`
        const userId = Number(session.client_reference_id);
        if (!userId) {
            throw new Error("No user ID in session's client_reference_id.");
        }

        // 3️⃣ Fetch the user record from Supabase
        const { data: user, error: userErr } = await supabase
            .from('users')
            .select('*')
            .eq('id', userId)
            .single();
        if (userErr || !user) {
            throw new Error('User not found in database.');
        }

        // 4️⃣ Find that user's team
        const { data: membership, error: memErr } = await supabase
            .from('teamMembers')
            .select('teamId')
            .eq('userId', user.id)
            .single();
        if (memErr || !membership) {
            throw new Error('User is not associated with a team.');
        }

        // 5️⃣ Update the team row in Supabase
        const { error: updErr } = await supabase
            .from('teams')
            .update({
                stripeCustomerId: customerId,
                stripeSubscriptionId: subscriptionId,
                stripeProductId: product.id,
                planName: product.name,
                subscriptionStatus: subscription.status,
                updatedAt: new Date().toISOString(),
            })
            .eq('id', membership.teamId);
        if (updErr) {
            console.error('Failed to update team in Supabase:', updErr);
            throw new Error('Failed to update subscription info.');
        }

        // 6️⃣ Re‐issue your own session cookie (if needed)
        await setSession(user);

        // 7️⃣ Redirect back into your app
        return NextResponse.redirect(new URL('/dashboard', request.url));
    } catch (err) {
        console.error('Error in Checkout callback:', err);
        return NextResponse.redirect(new URL('/error', request.url));
    }
}
