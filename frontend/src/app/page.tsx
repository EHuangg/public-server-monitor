import ServerHeartbeat from "@/components/ServerHeartbeat";

export default function HomePage() {
  return (
    <main className="flex min-h-screen items-center justify-center p-4 md:p-10">
      <ServerHeartbeat />
    </main>
  );
}
