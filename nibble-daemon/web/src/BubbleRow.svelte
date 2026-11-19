<script lang="ts">
  import BubblePanel from "./BubblePanel.svelte";
  import ConfirmButton from "./ConfirmButton.svelte";
  import {
    type Bubble,
    type DesiredInput,
    deleteBubble,
    errorMessage,
    restartBubble,
    saveBubble,
  } from "./lib/api";

  interface Props {
    bubble: Bubble;
    onchange: () => Promise<void>;
  }

  const ROUTING_LABELS = {
    routed: "Routed",
    pending: "Routes when ready",
    unrouted: "Unrouted",
  };

  let { bubble, onchange }: Props = $props();

  let expanded = $state(false);
  let pending = $state(false);
  let error = $state("");

  const status = $derived(bubble.running?.state ?? "inactive");
  const enabled = $derived(bubble.desired?.enabled ?? false);
  const shortHash = $derived(
    (bubble.running?.snapshotHash || bubble.desired?.snapshotHash || "").slice(
      0,
      8,
    ),
  );
  const routingWanted = $derived(
    bubble.desired?.routing ?? bubble.running?.routing ?? false,
  );
  const routing = $derived.by(() => {
    if (bubble.running?.routed) return "routed";
    return routingWanted ? "pending" : "unrouted";
  });
  const routingLabel = $derived(ROUTING_LABELS[routing]);

  const run = async (action: () => Promise<void>) => {
    pending = true;
    error = "";
    try {
      await action();
      await onchange();
    } catch (err) {
      error = errorMessage(err);
    } finally {
      pending = false;
    }
  };

  const save = (changes: Partial<DesiredInput>) => {
    const input = {
      snapshotHash:
        bubble.desired?.snapshotHash ?? bubble.running?.snapshotHash ?? "",
      enabled,
      routing: routingWanted,
      ...changes,
    };
    return run(() => saveBubble(bubble.name, input));
  };

  const toggleEnabled = () => save({ enabled: !enabled });

  const toggleRouting = () => save({ routing: !routingWanted });

  const restart = () => run(() => restartBubble(bubble.name));

  const remove = () => run(() => deleteBubble(bubble.name));
</script>

<tbody class:expanded>
  <tr data-status={status}>
    <td>
      <button
        type="button"
        class="toggle"
        aria-expanded={expanded}
        onclick={() => (expanded = !expanded)}
      >
        <span class="caret">{expanded ? "▾" : "▸"}</span>
        {bubble.name}
      </button>
      {#if !bubble.source}
        <span class="tag">no source</span>
      {/if}
    </td>
    <td><span class="status">{status}</span></td>
    <td class="mono">{shortHash || "latest"}</td>
    <td>
      <span class="routing" data-routing={routing}>{routingLabel}</span>
    </td>
    <td class="actions">
      <button type="button" disabled={pending} onclick={toggleEnabled}>
        {enabled ? "Stop" : "Start"}
      </button>
      <button type="button" disabled={pending} onclick={toggleRouting}>
        {routingWanted ? "Unroute" : "Route"}
      </button>
      {#if bubble.running}
        <button type="button" disabled={pending} onclick={restart}>
          Restart
        </button>
      {/if}
      <ConfirmButton label="Delete" disabled={pending} onconfirm={remove} />
    </td>
  </tr>
  {#if error}
    <tr>
      <td colspan="5"><span class="error" role="alert">{error}</span></td>
    </tr>
  {/if}
  {#if expanded}
    <tr class="detail">
      <td colspan="5">
        <BubblePanel name={bubble.name} {onchange} />
      </td>
    </tr>
  {/if}
</tbody>

<style>
  [data-status="running"] {
    --status-color: var(--ok);
  }

  [data-status="starting"],
  [data-status="stopping"] {
    --status-color: var(--warn);
  }

  [data-status="exited"] {
    --status-color: var(--danger);
  }

  [data-status="idle"],
  [data-status="inactive"] {
    --status-color: var(--idle);
  }

  tr[data-status] td:first-child {
    box-shadow: inset 3px 0 0 var(--status-color);
  }

  tr[data-status]:hover {
    background: var(--hover);
  }

  .expanded tr[data-status] {
    background: var(--hover);
  }

  .toggle {
    padding: 0;
    font-family: var(--font-mono);
    font-weight: 600;
    background: none;
    border: 0;
  }

  .toggle:hover:not(:disabled) {
    background: none;
    text-decoration: underline;
  }

  .caret {
    display: inline-block;
    width: 1rem;
    color: var(--muted);
  }

  .status {
    font-family: var(--font-mono);
    font-size: 0.75rem;
    font-weight: 600;
    letter-spacing: 0.05em;
    text-transform: uppercase;
    color: var(--status-color);
  }

  .status::before {
    content: "";
    display: inline-block;
    width: 0.5rem;
    height: 0.5rem;
    margin-right: 0.4rem;
    vertical-align: 0.05rem;
    background: currentColor;
  }

  [data-status="starting"] .status,
  [data-status="stopping"] .status {
    animation: pulse 1.2s ease-in-out infinite;
  }

  .routing {
    font-family: var(--font-mono);
    font-size: 0.75rem;
    letter-spacing: 0.05em;
    text-transform: uppercase;
    color: var(--muted);
  }

  [data-routing="routed"] {
    font-weight: 600;
    color: var(--accent);
  }

  [data-routing="pending"] {
    color: var(--warn);
  }

  @keyframes pulse {
    50% {
      opacity: 0.35;
    }
  }

  .detail > td {
    padding: 0;
    background: var(--sunken);
  }
</style>
