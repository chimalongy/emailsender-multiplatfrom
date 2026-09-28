import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { validSession } from '../../lib/security.js';
import Dashboard from '../../components/Dashboard.js';

export const dynamic = 'force-dynamic';

export default async function Page() {
    if (!validSession((await cookies()).get('session')?.value)) redirect('/login');
    return <Dashboard initialTab="Mailbox" />;
}
