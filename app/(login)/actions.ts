// app/actions.ts
'use server';

import { z } from 'zod';
import { supabase } from '@/lib/supabaseClient';
import {
    comparePasswords,
    hashPassword,
    setSession,
} from '@/lib/auth/session';
import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import { createCheckoutSession } from '@/lib/payments/stripe';
import { getUser, getUserWithTeam } from '@/lib/db/queries';
import {
    validatedAction,
    validatedActionWithUser,
} from '@/lib/auth/middleware';
import {
    ActivityType,
    type NewActivityLog,
    type NewUser,
    type NewTeam,
    type NewTeamMember,
} from '@/lib/db/schema';

async function logActivity(
    teamId: number | null | undefined,
    userId: number,
    type: ActivityType,
    ipAddress?: string
) {
    if (!teamId) return;
    const { error } = await supabase
        .from<NewActivityLog>('activityLogs')
        .insert([{ teamId, userId, action: type, ipAddress: ipAddress ?? '' }]);
    if (error) console.error('logActivity error:', error);
}

//
// Sign-In
//
const signInSchema = z.object({
    email: z.string().email().min(3).max(255),
    password: z.string().min(8).max(100),
});

export const signIn = validatedAction(
    signInSchema,
    async (data, formData) => {
        const { email, password } = data;

        // Fetch user + their team in one call
        const { data: userData, error: userErr } = await supabase
            .from('users')
            .select(`
        id,
        name,
        email,
        passwordHash,
        teamMembers (
          team (
            id,
            name,
            stripeCustomerId
          )
        )
      `)
            .eq('email', email)
            .single();

        if (userErr || !userData) {
            return { error: 'Invalid email or password.', email, password };
        }

        const isValid = await comparePasswords(
            password,
            // @ts-ignore
            userData.passwordHash
        );
        if (!isValid) {
            return { error: 'Invalid email or password.', email, password };
        }

        // Pull out the first (and usually only) team
        const foundTeam = userData.teamMembers?.[0]?.team ?? null;

        await Promise.all([
            setSession(userData),
            logActivity(foundTeam?.id, userData.id, ActivityType.SIGN_IN),
        ]);

        if (formData.get('redirect') === 'checkout') {
            const priceId = formData.get('priceId') as string;
            return createCheckoutSession({ team: foundTeam, priceId });
        }

        redirect('/dashboard');
    }
);

//
// Sign-Up
//
const signUpSchema = z.object({
    email: z.string().email(),
    password: z.string().min(8),
    inviteId: z.string().optional(),
});

export const signUp = validatedAction(
    signUpSchema,
    async (data, formData) => {
        const { email, password, inviteId } = data;

        // Duplicate check
        const { data: existing, error: exErr } = await supabase
            .from('users')
            .select('id')
            .eq('email', email)
            .limit(1)
            .single();

        if (exErr === null && existing) {
            return { error: 'Email already in use.', email, password };
        }

        const passwordHash = await hashPassword(password);

        // Create User
        const { data: createdUser, error: cuErr } = await supabase
            .from<NewUser>('users')
            .insert([{ email, passwordHash, role: 'owner' }])
            .single();

        if (cuErr || !createdUser) {
            return { error: 'Failed to create user.', email, password };
        }

        let teamId: number;
        let role: string;
        let createdTeam: NewTeam | null = null;

        if (inviteId) {
            // Accept invitation
            const { data: invite, error: iErr } = await supabase
                .from('invitations')
                .select('*')
                .eq('id', parseInt(inviteId))
                .eq('email', email)
                .eq('status', 'pending')
                .limit(1)
                .single();

            if (iErr || !invite) {
                return { error: 'Invalid or expired invitation.', email, password };
            }

            teamId = invite.teamId;
            role = invite.role;

            await supabase
                .from('invitations')
                .update({ status: 'accepted' })
                .eq('id', invite.id);

            await logActivity(teamId, createdUser.id, ActivityType.ACCEPT_INVITATION);

            const { data: teamData } = await supabase
                .from<NewTeam>('teams')
                .select('*')
                .eq('id', teamId)
                .single();
            createdTeam = teamData!;
        } else {
            // Create new team
            const { data: nt, error: ntErr } = await supabase
                .from<NewTeam>('teams')
                .insert([{ name: `${email}'s Team` }])
                .single();
            if (ntErr || !nt) {
                return { error: 'Failed to create team.', email, password };
            }
            teamId = nt.id;
            role = 'owner';
            createdTeam = nt;
            await logActivity(teamId, createdUser.id, ActivityType.CREATE_TEAM);
        }

        // Link user to team
        await supabase.from<NewTeamMember>('teamMembers').insert([
            { userId: createdUser.id, teamId, role },
        ]);
        await logActivity(teamId, createdUser.id, ActivityType.SIGN_UP);
        await setSession(createdUser);

        if (formData.get('redirect') === 'checkout') {
            const priceId = formData.get('priceId') as string;
            return createCheckoutSession({ team: createdTeam, priceId });
        }

        redirect('/dashboard');
    }
);

//
// Sign-Out
//
export async function signOut() {
    const user = await getUser();
    if (!user) return;
    const uwt = await getUserWithTeam(user.id);
    await logActivity(uwt?.teamId, user.id, ActivityType.SIGN_OUT);
    (await cookies()).delete('session');
}

//
// Update Password
//
const updatePasswordSchema = z
    .object({
        currentPassword: z.string().min(8).max(100),
        newPassword: z.string().min(8).max(100),
        confirmPassword: z.string().min(8).max(100),
    })
    .refine((d) => d.newPassword === d.confirmPassword, {
        message: "Passwords don't match",
        path: ['confirmPassword'],
    });

export const updatePassword = validatedActionWithUser(
    updatePasswordSchema,
    async (data, _, user) => {
        const isValid = await comparePasswords(
            data.currentPassword,
            user.passwordHash
        );
        if (!isValid) return { error: 'Incorrect current password.' };

        if (data.currentPassword === data.newPassword) {
            return { error: 'New password must differ from the old one.' };
        }

        const newHash = await hashPassword(data.newPassword);
        const uwt = await getUserWithTeam(user.id);

        await supabase
            .from('users')
            .update({ passwordHash: newHash })
            .eq('id', user.id);
        await logActivity(uwt?.teamId, user.id, ActivityType.UPDATE_PASSWORD);

        return { success: 'Password updated successfully.' };
    }
);

//
// Delete Account
//
const deleteAccountSchema = z.object({
    password: z.string().min(8).max(100),
});

export const deleteAccount = validatedActionWithUser(
    deleteAccountSchema,
    async (data, _, user) => {
        const isValid = await comparePasswords(data.password, user.passwordHash);
        if (!isValid) return { error: 'Incorrect password.' };

        const uwt = await getUserWithTeam(user.id);
        await logActivity(uwt?.teamId, user.id, ActivityType.DELETE_ACCOUNT);

        // Soft-delete: flag deletedAt and alter email for uniqueness
        await supabase
            .from('users')
            .update({
                deletedAt: new Date().toISOString(),
                email: `${user.email}-${user.id}-deleted`,
            })
            .eq('id', user.id);

        if (uwt?.teamId) {
            await supabase
                .from('teamMembers')
                .delete()
                .eq('userId', user.id)
                .eq('teamId', uwt.teamId);
        }

        (await cookies()).delete('session');
        redirect('/sign-in');
    }
);

//
// Update Account
//
const updateAccountSchema = z.object({
    name: z.string().min(1).max(100),
    email: z.string().email(),
});

export const updateAccount = validatedActionWithUser(
    updateAccountSchema,
    async (data, _, user) => {
        const uwt = await getUserWithTeam(user.id);
        await supabase
            .from('users')
            .update({ name: data.name, email: data.email })
            .eq('id', user.id);
        await logActivity(uwt?.teamId, user.id, ActivityType.UPDATE_ACCOUNT);
        return { success: 'Account updated successfully.' };
    }
);

//
// Remove Team Member
//
const removeTeamMemberSchema = z.object({
    memberId: z.number(),
});

export const removeTeamMember = validatedActionWithUser(
    removeTeamMemberSchema,
    async (data, _, user) => {
        const uwt = await getUserWithTeam(user.id);
        if (!uwt?.teamId) return { error: 'Not part of a team.' };

        await supabase
            .from('teamMembers')
            .delete()
            .eq('id', data.memberId)
            .eq('teamId', uwt.teamId);

        await logActivity(
            uwt.teamId,
            user.id,
            ActivityType.REMOVE_TEAM_MEMBER
        );
        return { success: 'Team member removed.' };
    }
);

//
// Invite Team Member
//
const inviteTeamMemberSchema = z.object({
    email: z.string().email(),
    role: z.enum(['member', 'owner']),
});

export const inviteTeamMember = validatedActionWithUser(
    inviteTeamMemberSchema,
    async (data, _, user) => {
        const uwt = await getUserWithTeam(user.id);
        if (!uwt?.teamId) return { error: 'Not part of a team.' };

        // Check existing membership
        const { data: exists, error: exErr } = await supabase
            .from('teamMembers')
            .select('id')
            .eq('teamId', uwt.teamId)
            .eq('userId', user.id)
            .single();

        if (exists) return { error: 'User already a member.' };

        // Check existing invitation
        const { data: inv, error: invErr } = await supabase
            .from('invitations')
            .select('id')
            .eq('teamId', uwt.teamId)
            .eq('email', data.email)
            .eq('status', 'pending')
            .single();

        if (inv) return { error: 'Invitation already sent.' };

        // Create invitation
        await supabase.from('invitations').insert([
            {
                teamId: uwt.teamId,
                email: data.email,
                role: data.role,
                invitedBy: user.id,
                status: 'pending',
            },
        ]);
        await logActivity(
            uwt.teamId,
            user.id,
            ActivityType.INVITE_TEAM_MEMBER
        );

        // TODO: email out the invitation link

        return { success: 'Invitation sent.' };
    }
);
