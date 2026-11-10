import type { BubbleState } from "./bubble-state";

export enum BubbleEvent {
  StateChange = "state-change",
  Exit = "exit",
}

export class StateChangeEvent extends CustomEvent<{ state: BubbleState }> {
  constructor(state: BubbleState) {
    super(BubbleEvent.StateChange, { detail: { state } });
  }
}

export class ExitEvent extends CustomEvent<{ error?: Error }> {
  constructor(error?: Error) {
    super(BubbleEvent.Exit, { detail: { error } });
  }
}
