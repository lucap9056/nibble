<script lang="ts">
  import ConfirmButton from "./ConfirmButton.svelte";
  import {
    type BubbleDetail,
    buildSnapshot,
    deleteSnapshot,
    errorMessage,
    getBubble,
    saveBubble,
  } from "./lib/api";

  interface Props {
    name: string;
    onchange: () => Promise<void>;
  }

  let { name, onchange }: Props = $props();

  let detail = $state<BubbleDetail | null>(null);
  let pending = $state(false);
  let error = $state("");

  const formatTime = (iso: string) => new Date(iso).toLocaleString();

  const load = async () => {
    try {
      detail = await getBubble(name);
    } catch (err) {
      error = errorMessage(err);
    }
  };

  const run = async (action: () => Promise<void>) => {
    pending = true;
    error = "";
    try {
      await action();
      await Promise.all([load(), onchange()]);
    } catch (err) {
      error = errorMessage(err);
    } finally {
      pending = false;
    }
  };

  const deploy = (snapshotHash: string) => {
    const input = {
      snapshotHash,
      enabled: detail?.desired?.enabled ?? true,
      routing: detail?.desired?.routing ?? false,
    };
    return run(() => saveBubble(name, input));
  };

  const build = () => run(() => buildSnapshot(name));

  const removeSnapshot = (hash: string) =>
    run(() => deleteSnapshot(name, hash));

  $effect(() => {
    load();
  });
</script>

<div class="panel">
  {#if detail}
    <dl>
      <dt>Entry</dt>
      <dd class="mono">{detail.source?.entry ?? "—"}</dd>
      <dt>Route</dt>
      <dd class="mono">{detail.running?.route || "—"}</dd>
      <dt>Started</dt>
      <dd>
        {detail.running ? formatTime(detail.running.createdAt) : "—"}
      </dd>
    </dl>

    <div class="toolbar">
      <h3>Snapshots</h3>
      <button type="button" disabled={pending} onclick={build}>
        Build snapshot
      </button>
    </div>
    <table>
      <thead>
        <tr>
          <th>Hash</th>
          <th>Created</th>
          <th></th>
          <th class="actions"></th>
        </tr>
      </thead>
      <tbody>
        {#each detail.snapshots as snapshot (snapshot.hash)}
          <tr>
            <td class="mono">{snapshot.hash}</td>
            <td>{formatTime(snapshot.createdAt)}</td>
            <td>
              {#if snapshot.running}
                <span class="tag">running</span>
              {/if}
              {#if snapshot.desired}
                <span class="tag">desired</span>
              {/if}
            </td>
            <td class="actions">
              {#if !snapshot.desired}
                <button
                  type="button"
                  disabled={pending}
                  onclick={() => deploy(snapshot.hash)}
                >
                  Deploy
                </button>
                <ConfirmButton
                  label="Delete"
                  disabled={pending}
                  onconfirm={() => removeSnapshot(snapshot.hash)}
                />
              {/if}
            </td>
          </tr>
        {:else}
          <tr>
            <td colspan="4" class="empty">No snapshots</td>
          </tr>
        {/each}
      </tbody>
    </table>
  {:else if !error}
    <p class="muted">Loading…</p>
  {/if}

  {#if error}
    <p class="error" role="alert">{error}</p>
  {/if}
</div>

<style>
  .panel {
    padding: 1rem 0.75rem 1.25rem 1.75rem;
  }

  dl {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: 0.35rem 1.5rem;
    margin: 0 0 1.25rem;
  }

  dt {
    color: var(--muted);
  }

  dd {
    margin: 0;
    word-break: break-all;
  }

  table {
    background: var(--surface);
    border: 1px solid var(--border);
  }

  tbody tr:last-child td {
    border-bottom: 0;
  }

  p {
    margin: 0.75rem 0 0;
  }
</style>
