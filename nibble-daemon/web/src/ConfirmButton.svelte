<script lang="ts">
  interface Props {
    label: string;
    disabled?: boolean;
    onconfirm: () => void;
  }

  let { label, disabled = false, onconfirm }: Props = $props();

  let armed = $state(false);

  const handleClick = () => {
    if (!armed) {
      armed = true;
      return;
    }
    armed = false;
    onconfirm();
  };

  const disarm = () => {
    armed = false;
  };
</script>

<button
  type="button"
  class="danger"
  class:armed
  {disabled}
  onclick={handleClick}
  onblur={disarm}
>
  {armed ? `Confirm ${label.toLowerCase()}` : label}
</button>

<style>
  .armed,
  .armed:hover:not(:disabled) {
    background: var(--danger);
    color: var(--surface);
    border-color: var(--danger);
  }
</style>
