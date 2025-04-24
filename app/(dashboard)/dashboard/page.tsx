// app/(settings)/page.tsx
import { redirect } from 'next/navigation';
import { Settings } from './settings';
import { getTeamForUser, getUser } from '@/lib/db/queries';

export default async function SettingsPage() {
    const user = await getUser();
    if (!user) redirect('/sign-in');

    const teamData = await getTeamForUser(user.id);
    if (!teamData) redirect('/create-team');

    return <Settings teamData={teamData} />;
}
