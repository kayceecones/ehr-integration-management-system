import { matchesSeed } from '../syncRegistry.ts';
let fails = 0;
const t = (label: string, got: boolean, want: boolean) => {
  if (got !== want) { fails++; console.log(`FAIL ${label}: got ${got} want ${want}`); }
  else console.log(`ok   ${label}`);
};
t('athenahealth Inc matches', matchesSeed('athenahealth, Inc.', 'athenahealth'), true);
t('Canvas Medical Inc matches', matchesSeed('Canvas Medical, Inc.', 'Canvas Medical'), true);
t('Elation Health Inc matches', matchesSeed('Elation Health, Inc.', 'Elation Health'), true);
t('Elation exact', matchesSeed('Elation Health', 'Elation Health'), true);
t('case insensitive', matchesSeed('CANVAS MEDICAL', 'Canvas Medical'), true);
t('does not cross-match unrelated', matchesSeed('Epic Systems Corporation', 'Canvas Medical'), false);
t('does not match Healthie to Elation Health', matchesSeed('Healthie', 'Elation Health'), false);
t('empty is false', matchesSeed('', 'Canvas Medical'), false);
t('suffix-only would be empty -> false', matchesSeed('Inc.', 'Canvas Medical'), false);
console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILURES`);
process.exit(fails === 0 ? 0 : 1);
