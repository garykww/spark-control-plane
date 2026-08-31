import { useEffect, useMemo, useState } from 'react';
import type { NodeSnapshot, Recipe, RecipePlan, Run, RunPhase } from '../lib/types';
import { api, type RunTuning } from '../lib/api';
import { bytes, duration, percent } from '../lib/format';
import { Badge, Button, Card, StatusDot } from './ui';
import { MemoryBar, type MemorySegment } from './viz/MemoryBar';
import { Meter } from './viz/Meter';

interface Props {
  node: NodeSnapshot;
  recipes: Recipe[];
  /* Set when recipes.yaml could not be read or is invalid. */
  error: string | null;
  onResult: (message: string) => void;
}

/*
 * Pick a serving configuration and start it.
 *
 * The panel deliberately does not offer the individual knobs - quantisation,
 * speculative method, KV dtype, memory fraction. Those constrain each other
 * (DFlash2 needs an unquantised lm_head; GDN layers need one specific mamba
 * cache mode), so a screen of independent dropdowns would mostly produce
 * combinations that fail at load. A recipe is a whole configuration that is
 * known to work, and the only question left is whether this node has room.
 *
 * That question is answered by the server on every poll, not here: `plan`
 * arrives alongside the memory reading it was computed from, so the figures the
 * panel shows and the ones the launch route enforces are the same figures.
 * Nothing here is optimistic either - a run appears when the node reports it.
 */
export function RunPlannerPanel({ node, recipes, error, onResult }: Props) {
  const [selected, setSelected] = useState<string | null>(null);
  const [tuning, setTuning] = useState<RunTuning>({});
  const [priced, setPriced] = useState<RecipePlan | null>(null);
  const [pricing, setPricing] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [pending, setPending] = useState<{
    recipe: Recipe;
    plan: RecipePlan;
    tuning: RunTuning;
  } | null>(null);

  const planById = useMemo(
    () => new Map(node.planner.plans.map((plan) => [plan.recipeId, plan])),
    [node.planner.plans],
  );
  const recipeById = useMemo(() => new Map(recipes.map((recipe) => [recipe.id, recipe])), [recipes]);

  /* A new selection starts from the recipe's own defaults. */
  useEffect(() => {
    setTuning({});
    setPriced(null);
  }, [selected]);

  /*
   * Re-priced whenever a knob moves. The arithmetic is the server's - the panel
   * posts the settings and renders the answer - so the figure on screen is by
   * construction the one the launch route will enforce. The poll keeps
   * replacing the baseline underneath, so this depends on the tuning alone;
   * otherwise every 2s tick would refetch a plan that has not changed.
   *
   * Debounced because a dragged slider emits a change per pixel. The handle
   * still moves at once - it reads the tuning directly - so only the figures
   * settle a moment behind the drag.
   */
  useEffect(() => {
    if (!selected) return undefined;
    let cancelled = false;

    const timer = setTimeout(() => {
      setPricing(true);
      api
        .planRun(node.nodeId, { recipeId: selected, ...tuning })
        .then((next) => {
          if (!cancelled) setPriced(next);
        })
        .catch(() => {
          /* Keep the last good plan; the poll's baseline is still valid. */
        })
        .finally(() => {
          if (!cancelled) setPricing(false);
        });
    }, 120);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [node.nodeId, selected, tuning]);

  /* The newest run is the only one worth a panel of its own; older ones are
   * swept off the node after a day. */
  const run = node.planner.runs[0] ?? null;
  const fitCount = node.planner.plans.filter((plan) => plan.fits).length;

  const selectedRecipe = selected ? (recipeById.get(selected) ?? null) : null;
  /* Until the first reply lands, the poll's own plan stands in, so selecting a
   * card never shows an empty panel or blank-flashes between answers. */
  const activePlan = selected ? (priced ?? planById.get(selected) ?? null) : null;

  /* A broken recipe file is worth saying out loud - it is a file somebody just
   * edited, and an empty panel would read as "no recipes exist". */
  if (error) {
    return (
      <Card title="Model runs" accent="var(--series-power)">
        <p className="text-[12px]" style={{ color: 'var(--status-serious)' }}>
          {error}
        </p>
        <p className="mt-2 text-[11px] text-ink-muted">
          Fix the recipe file and restart the server. Nothing else on this page is affected.
        </p>
      </Card>
    );
  }

  if (recipes.length === 0) return null;

  const act = async (key: string, action: () => Promise<string>) => {
    setBusy(key);
    try {
      onResult(await action());
    } catch (err) {
      onResult((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const confirmRun = async () => {
    if (!pending) return;
    const { recipe, tuning: chosen } = pending;
    setPending(null);
    await act('run', async () => {
      await api.startRun(node.nodeId, { recipeId: recipe.id, ...chosen });
      return `Starting ${recipe.name} on ${node.name}. It continues on the node if you close this page.`;
    });
  };

  return (
    <Card
      title="Model runs"
      accent="var(--series-power)"
      actions={
        <span className="text-[11px] text-ink-muted tabular">
          {fitCount} of {recipes.length} fit here
        </span>
      }
    >
      <MachineMemory node={node} plan={activePlan} pricing={pricing} />

      {run && <RunProgress node={node} run={run} busy={busy} act={act} />}

      <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {recipes.map((recipe) => {
          const plan = planById.get(recipe.id);
          if (!plan) return null;
          return (
            <RecipeCard
              key={recipe.id}
              recipe={recipe}
              plan={plan}
              selected={selected === recipe.id}
              onSelect={() => setSelected(selected === recipe.id ? null : recipe.id)}
            />
          );
        })}
      </div>

      {selectedRecipe && activePlan && (
        <RecipeDetail
          node={node}
          recipe={selectedRecipe}
          plan={activePlan}
          tuning={tuning}
          pricing={pricing}
          busy={busy !== null || Boolean(run && isLive(run.status))}
          onTune={(next) => setTuning((current) => ({ ...current, ...next }))}
          onRun={() => setPending({ recipe: selectedRecipe, plan: activePlan, tuning })}
        />
      )}

      {pending && (
        <ConfirmDialog
          node={node}
          recipe={pending.recipe}
          plan={pending.plan}
          onCancel={() => setPending(null)}
          onConfirm={confirmRun}
        />
      )}
    </Card>
  );
}

/*
 * The machine, and what the selected configuration would do to it.
 *
 * This is the question the panel exists to answer, so it is one bar of the
 * whole box rather than a per-recipe gauge: what is already spoken for, what
 * this run would take, and what would still be free afterwards.
 */
function MachineMemory({
  node,
  plan,
  pricing,
}: {
  node: NodeSnapshot;
  plan: RecipePlan | null;
  pricing: boolean;
}) {
  const total = plan?.memory.totalBytes ?? node.memory?.total ?? null;
  const available = plan?.memory.availableBytes ?? node.memory?.available ?? null;
  if (!total || available === null) return null;

  const inUse = Math.max(0, total - available);
  const needs = plan ? plan.memory.requiredBytes : 0;
  const spare = plan ? Math.max(0, (plan.memory.claimBytes ?? 0) - plan.memory.requiredBytes) : 0;
  const claimed = needs + spare;
  const over = Math.max(0, inUse + claimed - total);

  const segments: MemorySegment[] = [
    {
      key: 'in-use',
      label: plan ? 'Already in use' : 'In use',
      bytes: inUse,
      color: 'var(--series-memory)',
    },
  ];

  if (plan) {
    segments.push({
      key: 'run',
      label: 'This run needs',
      bytes: needs,
      color: 'var(--series-power)',
    });
    if (spare > 0) {
      segments.push({
        key: 'spare',
        label: 'Spare KV cache',
        bytes: spare,
        color: 'var(--series-power)',
        hatched: true,
      });
    }
  }

  const remaining = Math.max(0, total - inUse - claimed);

  return (
    <div
      className="rounded-lg border border-hairline p-3 transition-opacity duration-200"
      /* Re-pricing holds the last answer, dimmed, rather than clearing to a
       * skeleton - the figures stay readable and nothing jumps. */
      style={{ opacity: pricing ? 0.6 : 1 }}
    >
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-[12px] font-medium text-ink">
          {node.gpus[0]?.isUnified ? 'Unified memory' : 'Memory'} on {node.name}
        </span>
        <span className="text-[11px] text-ink-muted tabular">
          {bytes(remaining)} would still be free of {bytes(total)}
        </span>
      </div>

      <MemoryBar
        total={total}
        height={10}
        segments={segments}
        footnote={
          over > 0
            ? `${bytes(over)} more than this machine has — shorten the context, lower the request count, or free some memory.`
            : plan
              ? undefined
              : 'Select a recipe below to see how it would fit.'
        }
      />
    </div>
  );
}

/*
 * One recipe as a card. Cards rather than rows because the thing being compared
 * across them is a quantity - what each would cost - and a grid puts those
 * figures side by side instead of stacking them a screen apart.
 */
function RecipeCard({
  recipe,
  plan,
  selected,
  onSelect,
}: {
  recipe: Recipe;
  plan: RecipePlan;
  selected: boolean;
  onSelect: () => void;
}) {
  const cached = plan.repos.every((repo) => repo.cached);

  return (
    <button
      onClick={onSelect}
      aria-pressed={selected}
      className={`flex cursor-pointer flex-col gap-2 rounded-xl border p-3 text-left transition-colors ${
        selected ? 'border-[color:var(--series-power)] bg-surface-2' : 'border-hairline hover:bg-surface-2'
      }`}
    >
      <span className="flex items-start gap-2">
        <span className="mt-0.5 shrink-0">
          <StatusDot
            status={plan.fits ? 'good' : 'critical'}
            label={plan.fits ? 'Fits on this node' : 'Will not run here'}
          />
        </span>
        <span className="min-w-0 flex-1 text-[13px] font-medium text-ink">{recipe.name}</span>
      </span>

      <span className="line-clamp-2 text-[11px] text-ink-secondary">{recipe.summary}</span>

      <span className="mt-auto flex flex-wrap items-center gap-x-3 gap-y-1 pt-1">
        <span className="text-[13px] font-semibold text-ink tabular">
          {bytes(plan.memory.requiredBytes)}
        </span>
        <span className="text-[11px] text-ink-muted tabular">
          {plan.tuning
            ? `${Math.round(plan.tuning.contextLength / 1024)}K × ${plan.tuning.maxRequests}`
            : `port ${recipe.port}`}
        </span>
        {cached && <Badge tone="accent">cached</Badge>}
      </span>
    </button>
  );
}

const isLive = (status: Run['status']) =>
  status === 'starting' ||
  status === 'downloading' ||
  status === 'pulling' ||
  status === 'launching' ||
  status === 'waiting';

/*
 * The selected recipe: the knobs, the breakdown behind the bar above, and why
 * it cannot run. Presentational only - the pricing lives in the panel, because
 * the machine bar has to reflect the same answer this does.
 */
function RecipeDetail({
  node,
  recipe,
  plan,
  tuning,
  pricing,
  busy,
  onTune,
  onRun,
}: {
  node: NodeSnapshot;
  recipe: Recipe;
  plan: RecipePlan;
  /* The raw selections, which move the instant a slider does. The plan lags by
   * one round trip, so the handles read from here and the figures from there. */
  tuning: RunTuning;
  pricing: boolean;
  busy: boolean;
  onTune: (next: RunTuning) => void;
  onRun: () => void;
}) {
  const [showFlags, setShowFlags] = useState(false);

  /* A service declares one figure and has nothing to tune. */
  const knobs = plan.tuning;
  const minUtilization = knobs?.minUtilization ?? null;
  const automatic = knobs?.automatic ?? true;
  const utilization = knobs?.gpuMemoryUtilization ?? null;
  const contextLength = tuning.contextLength ?? knobs?.contextLength ?? 0;
  const maxRequests = tuning.maxRequests ?? knobs?.maxRequests ?? 0;

  /*
   * What vLLM reserves beyond what these settings actually need. In automatic
   * mode this is only the rounding step; an override makes it deliberate.
   */
  const surplus = Math.max(0, (plan.memory.claimBytes ?? 0) - plan.memory.requiredBytes);
  const bytesPerToken = plan.memory.kvTokens > 0 ? plan.memory.kvBytes / plan.memory.kvTokens : 0;
  const surplusTokens = bytesPerToken > 0 ? surplus / bytesPerToken : 0;
  const explainSurplus = surplus > 0 && !automatic;

  /*
   * The slider's steps: the computed minimum first, then round fractions above
   * it up to 0.95. Nothing below the minimum is offered at all - there the KV
   * cache could not hold one full-length request and vLLM would refuse to
   * start, so it is a position the control simply does not have.
   */
  const utilizationSteps = [
    ...(minUtilization === null ? [] : [minUtilization]),
    ...[0.5, 0.6, 0.7, 0.8, 0.9, 0.95].filter((value) => minUtilization === null || value > minUtilization),
  ];

  return (
    <div className="mt-4 rounded-xl border border-hairline bg-surface-2/40 p-4">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h4 className="text-[13px] font-semibold text-ink">{recipe.name}</h4>
        <span className="text-[11px] text-ink-muted">{recipe.summary}</span>
      </div>

      {knobs ? (
      <div className="flex flex-wrap items-start gap-x-6 gap-y-3">
        <Slider
          label="Context"
          value={contextLength}
          options={knobs.contextOptions}
          format={(value) => (value >= 1024 ? `${Math.round(value / 1024)}K tokens` : `${value} tokens`)}
          /* Changing the shape moves the minimum, so an absolute fraction chosen
           * against the old one is dropped rather than silently invalidated. */
          onChange={(value) => onTune({ contextLength: value, gpuMemoryUtilization: null })}
        />
        <Slider
          label="Max requests"
          value={maxRequests}
          options={knobs.requestOptions}
          format={(value) => `${value} request${value === 1 ? '' : 's'}`}
          onChange={(value) => onTune({ maxRequests: value, gpuMemoryUtilization: null })}
        />
        <Slider
          label="GPU memory"
          value={utilization ?? minUtilization ?? 0}
          options={utilizationSteps}
          format={(value) =>
            automatic || value === minUtilization ? `${value} · minimum` : String(value)
          }
          /* The first step IS the computed minimum, so sliding fully left hands
           * the fraction back to the planner instead of pinning today's number. */
          onChange={(value) =>
            onTune({ gpuMemoryUtilization: value === minUtilization ? null : value })
          }
        />
      </div>
      ) : (
        <p className="text-[11px] text-ink-muted">
          This recipe reserves a fixed {bytes(plan.memory.requiredBytes)} and takes no serving
          flags — it starts its own image and there is nothing to size.
        </p>
      )}

      {pricing && <p className="mt-2 text-[11px] text-ink-muted">pricing…</p>}

      {/* The bar above shows the shape; this is the arithmetic behind it. */}
      <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2 text-[11px] sm:grid-cols-4">
        {knobs ? (
          <>
            <Fact label="Weights" value={bytes(plan.memory.weightsBytes)} />
            <Fact label="Overhead" value={bytes(plan.memory.overheadBytes)} />
            <Fact
              label="KV cache"
              value={`${bytes(plan.memory.kvBytes)} · ${formatTokens(plan.memory.kvTokens)} tokens`}
            />
            <Fact
              label="Reserves"
              value={`${bytes(plan.memory.claimBytes)}${automatic ? ' (minimum)' : ` (${utilization})`}`}
            />
          </>
        ) : (
          <>
            <Fact label="Reserves" value={bytes(plan.memory.requiredBytes)} />
            <Fact label="Port" value={String(recipe.port)} />
            <Fact
              label="To download"
              value={plan.disk.downloadBytes > 0 ? bytes(plan.disk.downloadBytes) : 'nothing'}
            />
            <Fact label="Image" value={plan.imagePresent === false ? 'to build' : 'ready'} />
          </>
        )}
      </dl>

      {explainSurplus && (
        <p className="mt-2 text-[11px] text-ink-muted">
          <span
            aria-hidden
            className="mr-1.5 inline-block h-2 w-3 rounded-[2px] align-middle"
            style={{
              background:
                'repeating-linear-gradient(115deg, var(--series-power) 0 2px, transparent 2px 5px)',
              opacity: 0.65,
            }}
          />
          {bytes(surplus)} above the minimum — spare KV cache, worth about{' '}
          {formatTokens(surplusTokens)} more tokens of prefix cache.
        </p>
      )}

      <ul className="mt-3 space-y-1 text-[11px]">
        {plan.repos.map((repo) => (
          <li key={repo.repoId} className="flex items-center gap-2">
            <StatusDot status={repo.cached ? 'good' : 'neutral'} />
            <span className="truncate text-ink-secondary">{repo.repoId}</span>
            <span className="text-ink-muted">{repo.cached ? 'cached' : 'not on this node'}</span>
          </li>
        ))}
        <li className="flex items-center gap-2">
          <StatusDot status={plan.imagePresent === false ? 'neutral' : 'good'} />
          <span className="truncate text-ink-secondary">{recipe.imageRef}</span>
          <span className="text-ink-muted">
            {plan.imagePresent === false
              ? recipe.buildsImage
                ? 'will be built'
                : 'will be pulled'
              : plan.imagePresent
                ? 'on this node'
                : 'not checked yet'}
          </span>
        </li>
      </ul>

      {plan.blockers.map((issue) => (
        <p key={issue.code} className="mt-2 text-[11px]" style={{ color: 'var(--status-critical)' }}>
          {issue.message}
        </p>
      ))}
      {plan.warnings.map((issue) => (
        <p key={issue.code} className="mt-2 text-[11px] text-ink-muted">
          {issue.message}
        </p>
      ))}
      {recipe.notes.map((note) => (
        <p key={note} className="mt-2 text-[11px] text-ink-muted">
          {note}
        </p>
      ))}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Button
          variant="primary"
          disabled={!plan.fits || busy || pricing || !node.online}
          title={plan.fits ? undefined : plan.blockers[0]?.message}
          onClick={onRun}
        >
          Run this recipe
        </Button>
        {recipe.args.length > 0 && (
          <Button onClick={() => setShowFlags((value) => !value)}>
            {showFlags ? 'Hide flags' : 'Show flags'}
          </Button>
        )}
      </div>

      {showFlags && (
        <pre className="mt-3 overflow-x-auto rounded-lg bg-surface-2 p-3 text-[11px] leading-relaxed text-ink-secondary">
          {`vllm serve \\\n  ${tunedArgs(recipe, plan).join(' \\\n  ')}`}
        </pre>
      )}
    </div>
  );
}

/*
 * The argv as tuned, for display only - the run resolves its own server-side.
 * Kept in step with the server's resolveArgs: replace the two flags the picker
 * owns, then append the computed fraction.
 */
function tunedArgs(recipe: Recipe, plan: RecipePlan): string[] {
  const overrides: Record<string, string> = plan.tuning
    ? {
        '--max-model-len': String(plan.tuning.contextLength),
        '--max-num-seqs': String(plan.tuning.maxRequests),
      }
    : {};

  const args: string[] = [];
  for (let i = 0; i < recipe.args.length; i += 1) {
    const arg = recipe.args[i] ?? '';
    const replacement = overrides[arg];
    if (replacement !== undefined) {
      args.push(arg, replacement);
      i += 1; /* skip the recipe's own value */
      delete overrides[arg];
      continue;
    }
    args.push(arg);
  }
  for (const [flag, value] of Object.entries(overrides)) args.push(flag, value);
  if (plan.tuning?.gpuMemoryUtilization != null) {
    args.push('--gpu-memory-utilization', String(plan.tuning.gpuMemoryUtilization));
  }
  return args;
}

/* A label over its value. Used for the memory breakdown and the confirm
 * dialog, where the figures need to line up in columns. */
function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="truncate text-ink-muted">{label}</dt>
      <dd className="truncate text-ink-secondary tabular">{value}</dd>
    </div>
  );
}

const formatTokens = (tokens: number) =>
  tokens >= 1e6 ? `${(tokens / 1e6).toFixed(1)}M` : `${Math.round(tokens / 1000)}K`;

/*
 * A labelled slider over a fixed list of choices.
 *
 * The scales here are not linear - context doubles, concurrency doubles - so
 * the input runs over the INDEX of the choice, not its value. That keeps every
 * step one notch apart under the handle and under the arrow keys, instead of
 * cramming 8K..64K into the first 6% of the track.
 *
 * The value is always printed beside the label: a slider has no readout of its
 * own, and the whole point of these is the number they produce.
 */
function Slider({
  label,
  value,
  options,
  format,
  onChange,
  disabled,
}: {
  label: string;
  value: number;
  options: number[];
  format: (value: number) => string;
  onChange: (value: number) => void;
  disabled?: boolean;
}) {
  /* A stale value (options changed under it) lands on the nearest step rather
   * than snapping the handle to zero. */
  const exact = options.indexOf(value);
  const index =
    exact >= 0
      ? exact
      : options.reduce(
          (best, option, i) =>
            Math.abs(option - value) < Math.abs((options[best] ?? 0) - value) ? i : best,
          0,
        );

  const last = Math.max(0, options.length - 1);
  const progress = last === 0 ? 100 : (index / last) * 100;

  return (
    <label className="min-w-[8rem] flex-1">
      <span className="flex items-baseline justify-between gap-2">
        <span className="text-[11px] tracking-wide text-ink-muted uppercase">{label}</span>
        <span className="text-[12px] font-medium text-ink tabular">{format(value)}</span>
      </span>
      <input
        type="range"
        className="slider mt-1.5"
        min={0}
        max={last}
        step={1}
        value={index}
        disabled={disabled}
        onChange={(e) => onChange(options[Number(e.target.value)] ?? value)}
        aria-label={label}
        /* Screen readers would otherwise announce the index, which is meaningless. */
        aria-valuetext={format(value)}
        style={{
          /* Filled to the left of the handle, recessive to the right. */
          ['--slider-track' as string]: `linear-gradient(to right, var(--series-power) ${progress}%, var(--surface-2) ${progress}%)`,
        }}
      />
    </label>
  );
}

const PHASES: { key: RunPhase; label: string }[] = [
  { key: 'download', label: 'Weights' },
  { key: 'image', label: 'Image' },
  { key: 'launch', label: 'Container' },
  { key: 'wait', label: 'Loading' },
  { key: 'ready', label: 'Serving' },
];

const STATUS_TONE = {
  ready: 'good',
  failed: 'critical',
  blocked: 'critical',
  orphaned: 'critical',
  cancelled: 'neutral',
} as const;

/*
 * The run in flight. Only the download phase has a total to divide by, so it is
 * the only one that gets a bar - the others show which step is under way and
 * the last line the node logged, which is more honest than a progress bar that
 * would have to be invented.
 */
function RunProgress({
  node,
  run,
  busy,
  act,
}: {
  node: NodeSnapshot;
  run: Run;
  busy: string | null;
  act: (key: string, action: () => Promise<string>) => Promise<void>;
}) {
  const live = isLive(run.status);
  const elapsed = run.startedAt ? duration((run.finishedAt ?? Date.now() / 1000) - run.startedAt) : null;
  const reached = PHASES.findIndex((phase) => phase.key === run.phase);

  /*
   * A run ends the moment the endpoint answers, but the container outlives it -
   * and can be stopped from the panel below, or die on its own. So "serving" is
   * asserted from `docker ps` on the current poll, never from the run's exit
   * code, which only says what was true when the script finished.
   */
  const container = node.containers.find((entry) => entry.name === run.containerName);
  const serving = run.status === 'ready' && container?.state === 'running';
  const stopped = run.status === 'ready' && !serving;

  const tone = live ? 'warning' : stopped ? 'neutral' : STATUS_TONE[run.status as keyof typeof STATUS_TONE] ?? 'neutral';

  return (
    <div className="mb-5 rounded-lg border border-hairline p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <StatusDot status={tone} />
            <span className="truncate text-[13px] font-medium text-ink">{run.recipeName}</span>
            <Badge>{stopped ? 'stopped' : run.status}</Badge>
          </div>
          <p className="mt-0.5 truncate text-[11px] text-ink-muted">
            {run.modelRepoId || run.containerName}
            {elapsed && ` · ${live ? 'running' : 'took'} ${elapsed}`}
          </p>
        </div>

        <div className="flex shrink-0 gap-1.5">
          {live ? (
            <Button
              variant="danger"
              disabled={busy !== null}
              onClick={() =>
                act(`cancel:${run.id}`, async () => {
                  await api.cancelRun(node.nodeId, run.id);
                  return `Cancelled ${run.recipeName}.`;
                })
              }
            >
              Cancel
            </Button>
          ) : (
            <>
              {serving && (
                <Button
                  variant="danger"
                  disabled={busy !== null}
                  onClick={() =>
                    act(`stop:${run.id}`, async () => {
                      await api.stopRun(node.nodeId, run.id);
                      return `Stopped ${run.containerName}.`;
                    })
                  }
                >
                  Stop server
                </Button>
              )}
              <Button
                disabled={busy !== null}
                onClick={() =>
                  act(`clear:${run.id}`, async () => {
                    await api.clearRun(node.nodeId, run.id);
                    return `Dismissed ${run.recipeName}.`;
                  })
                }
              >
                Dismiss
              </Button>
            </>
          )}
        </div>
      </div>

      {/* Step trail. Colour alone never carries this: every step keeps its
          label, and the status badge above names the current state in words. */}
      <ol className="mt-3 flex flex-wrap gap-1.5" aria-label="run progress">
        {PHASES.map((phase, index) => {
          const done = run.status === 'ready' || (reached > -1 && index < reached);
          const current = reached === index && live;
          return (
            <li
              key={phase.key}
              className="rounded-md px-2 py-0.5 text-[10px] font-medium tracking-wide uppercase"
              style={{
                background: current ? 'var(--series-power)' : 'var(--surface-2)',
                color: current ? '#fff' : done ? 'var(--ink-secondary)' : 'var(--ink-muted)',
              }}
            >
              {phase.label}
            </li>
          );
        })}
      </ol>

      {run.status === 'downloading' && (
        <div className="mt-3">
          <Meter
            label="Fetching weights"
            value={run.percent}
            color="var(--series-llm)"
            readout={
              run.totalBytes ? `${bytes(run.downloadedBytes)} / ${bytes(run.totalBytes)}` : bytes(run.downloadedBytes)
            }
            sublabel={
              run.percent === null ? 'total size unknown — showing bytes downloaded' : percent(run.percent)
            }
            height={6}
          />
        </div>
      )}

      {run.message && <p className="mt-2 truncate text-[11px] text-ink-muted">{run.message}</p>}

      {stopped && (
        <p className="mt-2 text-[11px] text-ink-muted">
          This recipe served successfully, but {run.containerName} is no longer running. Run it again to bring
          it back — the weights and image are cached now, so it only has to start.
        </p>
      )}

      {serving && run.port && (
        <div className="mt-3 rounded-lg bg-surface-2 px-3 py-2 text-[11px] text-ink-secondary">
          Serving on{' '}
          <code className="text-ink">
            http://{node.host?.hostname ?? node.name}:{run.port}/v1
          </code>
          {run.apiKey && (
            <>
              {' — clients must send '}
              <code className="text-ink break-all">Authorization: Bearer {run.apiKey}</code>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/* Starting a recipe downloads tens of gigabytes and publishes a port, so it
 * states both before it happens rather than after. */
function ConfirmDialog({
  node,
  recipe,
  plan,
  onCancel,
  onConfirm,
}: {
  node: NodeSnapshot;
  recipe: Recipe;
  plan: RecipePlan;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4 backdrop-blur-sm"
      onClick={(e) => e.target === e.currentTarget && onCancel()}
    >
      <div className="w-full max-w-md rounded-xl border border-hairline bg-surface-1 p-5 shadow-2xl">
        <h3 className="text-[15px] font-semibold text-ink">
          Run {recipe.name} on {node.name}?
        </h3>

        <ol className="mt-3 space-y-1.5 text-[12px] text-ink-secondary">
          <li>
            {plan.disk.downloadBytes > 0
              ? `Download ${bytes(plan.disk.downloadBytes)} of weights, which can take hours.`
              : 'The weights are already cached on this node.'}
          </li>
          <li>
            {plan.imagePresent === false
              ? `${recipe.buildsImage ? 'Build' : 'Pull'} ${recipe.imageRef}.`
              : `Use ${recipe.imageRef}, already on this node.`}
          </li>
          <li>
            Start <span className="text-ink">{recipe.containerName}</span> and wait for the model to load.
          </li>
        </ol>

        {/* The settings being committed to, since they are what the memory
            figure was priced at and what the container will actually serve. */}
        <dl className="mt-3 grid grid-cols-3 gap-x-3 rounded-lg bg-surface-2 px-3 py-2 text-[11px]">
          {plan.tuning ? (
            <>
              <Fact label="Context" value={`${Math.round(plan.tuning.contextLength / 1024)}K`} />
              <Fact label="Max requests" value={String(plan.tuning.maxRequests)} />
              <Fact
                label="GPU memory"
                value={`${bytes(plan.memory.claimBytes)}${plan.tuning.automatic ? ' (min)' : ''}`}
              />
            </>
          ) : (
            <>
              <Fact label="Reserves" value={bytes(plan.memory.requiredBytes)} />
              <Fact label="Port" value={String(recipe.port)} />
              <Fact label="Web UI" value="no auth" />
            </>
          )}
        </dl>

        <p className="mt-3 text-[11px] text-ink-muted">
          The server is published on port {recipe.port} of every interface, protected only by a generated API
          key. The run continues on the node if you close this page.
        </p>

        <div className="mt-4 flex justify-end gap-2">
          <Button onClick={onCancel}>Cancel</Button>
          <Button variant="primary" onClick={onConfirm}>
            Run
          </Button>
        </div>
      </div>
    </div>
  );
}
