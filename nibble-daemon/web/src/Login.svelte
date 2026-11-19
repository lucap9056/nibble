<script lang="ts">
  import { ApiError, changePassword, login } from "./lib/api";
  import { session } from "./lib/session.svelte";

  const MIN_PASSWORD_LENGTH = 8;

  let mode = $state<"login" | "change">("login");
  let password = $state("");
  let newPassword = $state("");
  let confirmPassword = $state("");
  let error = $state("");
  let pending = $state(false);

  const describe = (err: unknown) => {
    if (!(err instanceof ApiError)) return "Unable to reach the daemon";
    switch (err.status) {
      case 401:
        return "Incorrect password";
      case 429:
        return "Too many failed attempts, try again later";
      default:
        return err.message;
    }
  };

  const submitLogin = async () => {
    try {
      const started = await login(password);
      session.start(started);
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) {
        mode = "change";
        return;
      }
      error = describe(err);
    }
  };

  const submitChange = async () => {
    if (newPassword !== confirmPassword) {
      error = "Passwords do not match";
      return;
    }
    try {
      await changePassword(password, newPassword);
      const started = await login(newPassword);
      session.start(started);
    } catch (err) {
      error = describe(err);
    }
  };

  const handleSubmit = async (event: SubmitEvent) => {
    event.preventDefault();
    error = "";
    pending = true;
    try {
      if (mode === "login") {
        await submitLogin();
      } else {
        await submitChange();
      }
    } finally {
      pending = false;
    }
  };
</script>

<form class="card" onsubmit={handleSubmit}>
  <h1>nibble</h1>
  {#if mode === "login"}
    <label>
      Password
      <input
        type="password"
        autocomplete="current-password"
        required
        bind:value={password}
      >
    </label>
  {:else}
    <p>Set a new password before continuing.</p>
    <label>
      New password
      <input
        type="password"
        autocomplete="new-password"
        minlength={MIN_PASSWORD_LENGTH}
        required
        bind:value={newPassword}
      >
    </label>
    <label>
      Confirm password
      <input
        type="password"
        autocomplete="new-password"
        minlength={MIN_PASSWORD_LENGTH}
        required
        bind:value={confirmPassword}
      >
    </label>
  {/if}
  {#if error}
    <p class="error" role="alert">{error}</p>
  {/if}
  <button type="submit" class="primary" disabled={pending}>
    {mode === "login" ? "Sign in" : "Change password"}
  </button>
</form>

<style>
  .card {
    display: flex;
    flex-direction: column;
    gap: 1rem;
    width: min(22rem, 100% - 2rem);
    margin: 18vh auto 0;
    padding: 2rem;
    background: var(--surface);
    border: 1px solid var(--border);
  }

  h1 {
    margin: 0 0 0.5rem;
    font-family: var(--font-mono);
    font-size: 1.25rem;
  }

  label {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    font-size: 0.85rem;
    color: var(--muted);
  }

  input {
    color: var(--fg);
  }

  p {
    margin: 0;
  }
</style>
