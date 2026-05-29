import { SportToggle } from "@/components/dashboard/sport-toggle";
import { RunningSection } from "@/components/dashboard/sections/running-section";
import { LiftingSection } from "@/components/dashboard/sections/lifting-section";

export const dynamic = "force-dynamic";

export default async function TrainPage({
  searchParams,
}: {
  searchParams?: Promise<{ y?: string; m?: string; shoe?: string; reason?: string }>;
}) {
  return (
    <div className="space-y-8">
      <div>
        <p className="text-sm tracking-widest text-stone-500 uppercase">Training</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight text-stone-900">Train</h1>
        <p className="mt-2 text-base leading-relaxed text-stone-600">
          Runs and lifts in one place. Switch between them below.
        </p>
      </div>

      <SportToggle
        run={<RunningSection searchParams={searchParams} />}
        lift={<LiftingSection searchParams={searchParams} />}
      />
    </div>
  );
}
