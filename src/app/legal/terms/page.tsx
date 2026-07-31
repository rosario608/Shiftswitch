import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Terms of use",
  robots: { index: true, follow: true },
};

const EFFECTIVE_DATE = "1 August 2026";

export default function TermsPage() {
  return (
    <article>
      <h1 className="mb-1 text-3xl font-bold text-ink">Terms of use</h1>
      <p className="text-sm text-ink-subtle">Effective {EFFECTIVE_DATE}</p>

      <h2>What ShiftSwitch is</h2>
      <p>
        ShiftSwitch is a scheduling tool for resident physicians to arrange
        shift switches with each other, subject to their program&rsquo;s rules
        and, where required, a chief resident&rsquo;s approval. It is provided
        by your residency program or its institution.
      </p>
      <p>
        <strong>ShiftSwitch is not a clinical system.</strong> It gives no
        medical advice, makes no clinical decisions, and holds no patient
        information. Nothing in it should be relied on for patient care.
      </p>

      <h2>Who may use it</h2>
      <p>
        Only people your program has authorised: residents, chief residents and
        program administrators, signing in with the work account your program
        has on file. Accounts are personal. Do not share your account or let
        anybody else act as you.
      </p>

      <h2>What you agree to</h2>
      <ul>
        <li>
          Use ShiftSwitch only for arranging and recording your own shift
          switches.
        </li>
        <li>
          Never enter patient information, protected health information, or any
          other person&rsquo;s personal information into a note, a reason or an
          email.
        </li>
        <li>
          Only post shifts you are actually assigned to, and only agree to
          switches you intend to honour.
        </li>
        <li>
          Follow your program&rsquo;s own policies, including duty-hour rules.
          The rules built into ShiftSwitch are a check, not a substitute for
          them.
        </li>
        <li>
          Do not attempt to access another person&rsquo;s account, schedule or
          data, or to circumvent the approval process.
        </li>
      </ul>

      <h2>A switch is a real commitment</h2>
      <p>
        When a switch completes, the schedule changes for both residents and the
        record shows who is responsible for each shift. Sending the notification
        email to your program coordinator is your responsibility — ShiftSwitch
        composes it and opens it in your own mail application, but it cannot see
        your mailbox and cannot confirm you sent it. Your program&rsquo;s own
        process decides when a switch is officially recognised.
      </p>

      <h2>Rules, approvals and overrides</h2>
      <p>
        ShiftSwitch checks each proposed switch against the rules your program
        configured and blocks or escalates accordingly. Those rules are set by
        your program, not by ShiftSwitch, and a chief resident may override a
        failed rule with a written reason, which is recorded. A switch passing
        the checks does not mean it complies with every applicable regulation;
        responsibility for that stays with you and your program.
      </p>

      <h2>Availability</h2>
      <p>
        The service is provided as-is. It may be unavailable for maintenance or
        because of a failure outside anyone&rsquo;s control. Do not rely on it
        as the only record of your schedule near a shift you must attend —
        confirm with your program if anything is unclear.
      </p>

      <h2>Your content</h2>
      <p>
        Notes you write on a post, reasons you give, and approval notes are
        visible to the other residents involved and to your program, and are
        kept in the audit record. Keep them professional and free of anyone
        else&rsquo;s personal information.
      </p>

      <h2>Suspension</h2>
      <p>
        Your program administrator may deactivate your account — for example
        when you leave the program, or if the account is misused. Deactivation
        ends access; it does not remove the record of switches you completed.
      </p>

      <h2>Ending your use</h2>
      <p>
        You can delete your account from Settings at any time, subject to having
        no upcoming shifts still assigned to you and no live posts. See the{" "}
        <a className="text-brand-ink underline" href="/legal/privacy">
          privacy policy
        </a>{" "}
        for exactly what is removed and what your program keeps.
      </p>

      <h2>Liability</h2>
      <p>
        To the extent permitted by law, the operator is not liable for indirect
        or consequential loss arising from use of ShiftSwitch, including missed
        shifts, scheduling conflicts, or a switch that a program does not
        recognise. Nothing here limits liability that cannot be limited by law.
      </p>

      <h2>Changes</h2>
      <p>
        These terms may change; material changes will be shown in the app before
        they take effect. Continuing to use ShiftSwitch after that means you
        accept the revised terms.
      </p>

      <h2>Questions</h2>
      <p>
        Contact your program coordinator or administrator, who can escalate to
        the institution&rsquo;s legal or privacy office.
      </p>
    </article>
  );
}
