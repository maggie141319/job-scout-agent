import { redirect } from "next/navigation";
import { currentAdmin } from "@/lib/auth";
import { LoginForm } from "./login-form";

export const metadata = { title: "Admin sign in · US Cabinet World" };

export default async function LoginPage() {
  if (await currentAdmin()) redirect("/admin");
  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center px-4">
      <h1 className="mb-1 text-2xl font-bold">US Cabinet World</h1>
      <p className="mb-6 text-slate-600">Time clock administration</p>
      <LoginForm />
    </main>
  );
}
