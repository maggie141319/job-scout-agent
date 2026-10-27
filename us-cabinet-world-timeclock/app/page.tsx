import { currentKiosk } from "@/lib/auth";
import { TimeClock } from "./time-clock";

export default async function Home() {
  const kiosk = await currentKiosk().catch(() => null);
  return <TimeClock kioskName={kiosk?.name ?? null} />;
}
