// The usage text of `openmorals order`, apart from the command so the CLI's help (and the hook process that loads the
// CLI) does not load the order command, its readers or the office checks (ruling R3).
import { CONDITION_KINDS, ORDER_KINDS } from './model.js';

export const ORDER_USAGE = `  openmorals order new [--kind ${ORDER_KINDS.join('|')}] [--input FILE]... [--output FILE]...
                  [--template NAME]
      Print the start of a work order (YAML) with each input's sha256 filled in.
      Writes nothing. Conditions: ${CONDITION_KINDS.join(', ')}.
  openmorals order approve <order.yaml> [--yes]
      Approve a work order yourself: shows its conditions, what they do not check,
      and, for an order approved before, each edit since as a loosening, a
      tightening or a change. Stores the order's hash (and its text) in
      orders/approvals.jsonl in the config directory. In a terminal it asks (type
      yes); elsewhere nothing is stored without --yes. An agent running it is
      asked or refused by the hook. Exit 0 approved or already approved
      unchanged, 1 not approved (invalid order, an input that does not match its
      sha256, a template that lost a condition, not confirmed).
  openmorals order baseline <order.yaml> [--yes]
      Take the office baseline yourself at the order's start (0.30.0): a copy of
      each .xlsx and .docx file the order names, kept in the config directory
      under its SHA-256, that before_after conditions compare against. Refuses a
      file that does not read as its kind. In a terminal it asks (type yes);
      elsewhere nothing is stored without --yes. An agent running it is asked or
      refused by the hook. Exit 0 taken, 1 not taken.
  openmorals order check [<order.yaml>] [--run ID] [--json]
      Check the work against an approved order (default: $OPENMORALS_ORDER): each
      input's sha256, each output, each condition. Prints what a pass does not
      show beside every pass, and writes the result to the audit log with the run
      id (--run, else $OPENMORALS_RUN). Exit 0 every check passed and the order
      is approved as it reads now, 1 anything failed or the order is missing,
      invalid, not approved or edited after approval, 2 the result could not be
      written to the record (read it as not passed), 64 usage error.`;
