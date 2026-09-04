/**
 * The clicker / recording how-to, in one place. Read by the Bluetooth guide
 * page (Profile → Bluetooth Clicker) and the Troubleshoot sheet on the record
 * screen so the two can never disagree. Plain words, step by step — Henry
 * (4 Sep): "explain really simply in dot points how to do things".
 */
export interface HelpSection {
  key: string;
  title: string;
  steps: string[];
}

/** The three steps to get a clicker working. */
export const CONNECT_STEPS: { title: string; body: string }[] = [
  {
    title: 'Turn the clicker on',
    body: 'Slide its switch on (or hold the button until the light blinks). It pairs like a Bluetooth keyboard — no app needed for this bit.',
  },
  {
    title: 'Pair it in iPhone Settings',
    body: 'Settings → Bluetooth → tap your clicker (usually "AB Shutter3"). It should say Connected.',
  },
  {
    title: 'Come back and press it once',
    body: 'On the record screen the badge turns green and says Clicker. One press starts a shot, one press stops it.',
  },
];

export const HELP_SECTIONS: HelpSection[] = [
  {
    key: 'connect',
    title: 'Connecting the clicker',
    steps: CONNECT_STEPS.map((s, i) => `${i + 1}. ${s.title} — ${s.body}`),
  },
  {
    key: 'record',
    title: 'Recording a shot',
    steps: [
      'Press the clicker once (or the big red button) to start. The REC pill shows and the phone light comes on.',
      'Hit the shot.',
      'Press once more to stop. The clip is saved to the hole you are on.',
      'Shots under 2 seconds are ignored — that is a mis-press, not a shot.',
    ],
  },
  {
    key: 'next-hole',
    title: 'Moving to the next hole',
    steps: [
      'Double-press the clicker, or tap Next Hole at the bottom right.',
      'The hole number at the top changes. Your score for the finished hole is set from the shots you recorded plus any penalties.',
      'Prev takes you back a hole if you moved on too early.',
    ],
  },
  {
    key: 'penalty',
    title: 'Adding a penalty',
    steps: [
      'Triple-press the clicker, or tap Penalty at the bottom left and pick the type.',
      'A penalty adds a stroke to this hole. No video is recorded for it.',
    ],
  },
  {
    key: 'delete',
    title: 'Deleting or restoring a shot',
    steps: [
      'Options (top left) → Delete last shot on this hole.',
      'Changed your mind? Options → Restore deleted shot.',
      'Everything you delete is also in Profile → Recently deleted.',
    ],
  },
  {
    key: 'not-working',
    title: 'The clicker is not doing anything',
    steps: [
      'Look at the badge at the top left. Green "Clicker" means a press was heard; grey "No Clicker" means nothing has arrived yet.',
      'Press it once. If the badge stays grey: Settings → Bluetooth → tap the (i) next to your clicker → Forget This Device, then pair it again.',
      'Check the clicker has battery — the light should blink when you press.',
      'The clicker works like a volume button. Clippar takes care of that; you do not need to change your volume.',
      'Still nothing? Use the on-screen record button — it does exactly the same thing.',
    ],
  },
  {
    key: 'cut-short',
    title: '"Recording was cut short"',
    steps: [
      'A phone call, Siri or another app took the microphone mid-shot.',
      'The shot is kept up to the point it was cut; you can trim it in the editor.',
      'Keep the phone free during a shot and it will not happen.',
    ],
  },
  {
    key: 'light',
    title: 'The recording light',
    steps: [
      'The torch comes on while a shot records so you can see it from the tee.',
      'Turn it off in Options → Recording light.',
    ],
  },
  {
    key: 'end',
    title: 'Ending the round',
    steps: [
      'Tap End Round at the top right. Your shots open in the editor.',
      'Not finished? Options → Review round so far shows what you have without ending anything.',
    ],
  },
];
