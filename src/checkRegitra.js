const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const TARGET_URL = 'https://www.eregitra.lt/services/vehicle-registration/data-search';
const ARTIFACT_DIR = path.join(process.cwd(), 'artifacts');
const SCREENSHOT_PATH = path.join(ARTIFACT_DIR, 'last-page.png');
const PAGE_TEXT_PATH = path.join(ARTIFACT_DIR, 'last-page.txt');

const requiredEnv = [
  'REGITRA_PLATE_NUMBER',
  'REGITRA_REG_CERT_NUMBER'
];

const missing = requiredEnv.filter((key) => !process.env[key]);
if (missing.length) {
  console.error(`Missing required env vars: ${missing.join(', ')}`);
  process.exit(1);
}

const vehicleData = {
  plate: process.env.REGITRA_PLATE_NUMBER.trim(),
  certNumber: process.env.REGITRA_REG_CERT_NUMBER.trim()
};

const isTruthy = (value) => ['1', 'true', 'yes', 'on'].includes(String(value || '').toLowerCase());
const telegramConfig = {
  botToken: (process.env.TELEGRAM_BOT_TOKEN || '').trim(),
  chatId: (process.env.TELEGRAM_CHAT_ID || '').trim()
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function randomPause(min = 160, max = 520) {
  const ms = Math.floor(Math.random() * (max - min + 1)) + min;
  await sleep(ms);
}

async function typeHuman(locator, value) {
  await locator.click({ timeout: 8000 });
  await locator.fill('');

  for (const ch of value) {
    await locator.type(ch, { delay: Math.floor(Math.random() * 90) + 45 });
  }
}

async function fillFromCandidates(page, candidates, value, label) {
  for (const selector of candidates) {
    const locator = page.locator(selector).first();
    if (await locator.count()) {
      try {
        await locator.waitFor({ state: 'visible', timeout: 3000 });
        await typeHuman(locator, value);
        return true;
      } catch (err) {
        // try next selector
      }
    }
  }

  throw new Error(`Could not locate input field for ${label}`);
}

async function clickFirstAvailable(page, selectors) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if (await locator.count()) {
      try {
        await locator.waitFor({ state: 'visible', timeout: 2500 });
        await locator.click({ timeout: 2500 });
        return true;
      } catch (err) {
        // continue trying
      }
    }
  }
  return false;
}

async function clickAllRequiredCheckboxes(page) {
  const formScope = page.locator('input#registrationNo').first().locator('xpath=ancestor::form[1]');
  let checkboxes = formScope.locator('input[type="checkbox"]:visible');
  let count = await checkboxes.count();

  if (count === 0) {
    checkboxes = page.locator('input.jss69[type="checkbox"]:visible');
    count = await checkboxes.count();
  }
  if (count === 0) {
    checkboxes = page.locator('input[type="checkbox"]:visible');
    count = await checkboxes.count();
  }
  if (count === 0) {
    throw new Error('Required checkboxes not found.');
  }

  for (let i = 0; i < count; i += 1) {
    const checkbox = checkboxes.nth(i);
    const checked = await checkbox.isChecked().catch(() => false);
    if (!checked) {
      await checkbox.check({ force: true }).catch(async () => {
        await checkbox.click({ force: true });
      });
      await randomPause(120, 320);
    }
  }
}

async function fillDirectById(page, id, value, label) {
  const locator = page.locator(`input#${id}`).first();
  if (!(await locator.count())) return false;
  try {
    await locator.waitFor({ state: 'visible', timeout: 5000 });
    await typeHuman(locator, value);
    return true;
  } catch (err) {
    throw new Error(`Could not fill ${label} via #${id}`);
  }
}

async function fillByLabelCandidates(page, labels, value) {
  for (const label of labels) {
    const locator = page.getByLabel(label, { exact: false }).first();
    if (await locator.count()) {
      try {
        await locator.waitFor({ state: 'visible', timeout: 3000 });
        await typeHuman(locator, value);
        return true;
      } catch (err) {
        // try next label
      }
    }
  }
  return false;
}

async function fillByVisibleTextInputIndex(page, index, value, label) {
  const locator = page.locator('input[type="text"]:visible').nth(index);
  if (!(await locator.count())) {
    throw new Error(`Could not locate text input #${index + 1} for ${label}`);
  }
  await locator.waitFor({ state: 'visible', timeout: 3000 });
  await typeHuman(locator, value);
}

function extractStatus(text, labelVariants) {
  const normalized = text.replace(/\s+/g, ' ').trim();

  for (const label of labelVariants) {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(
      `${escaped}[^A-Za-z0-9]{0,30}(galioja|negalioja|draudžiamas|draudziamas|leidžiamas|leidziamas|taip|ne|valid|invalid)?`,
      'i'
    );
    const match = normalized.match(regex);

    if (match && match[1]) {
      const value = match[1].toLowerCase();
      if (
        value.includes('negalioja') ||
        value.includes('draudžiamas') ||
        value.includes('draudziamas') ||
        value === 'ne' ||
        value === 'invalid'
      ) {
        return 'NE';
      }
      if (
        value.includes('galioja') ||
        value.includes('leidžiamas') ||
        value.includes('leidziamas') ||
        value === 'taip' ||
        value === 'valid'
      ) {
        return 'TAIP';
      }
    }

    const lineRegex = new RegExp(`(${escaped}[^\\n]*)`, 'i');
    const lineMatch = text.match(lineRegex);
    if (lineMatch) {
      const line = lineMatch[1].toLowerCase();
      if (
        line.includes('negalioja') ||
        line.includes('draudžiamas') ||
        line.includes('draudziamas') ||
        /\bne\b/.test(line)
      ) {
        return 'NE';
      }
      if (
        line.includes('galioja') ||
        line.includes('leidžiamas') ||
        line.includes('leidziamas') ||
        /\btaip\b/.test(line)
      ) {
        return 'TAIP';
      }
    }
  }

  return 'NERASTA';
}

async function detectCaptchaLike(page) {
  // If the normal search form is present, this is not the anti-bot page.
  const hasNormalForm = (await page.locator('#registrationNo, #plateNo, button:has-text("IEŠKOTI"), button:has-text("Ieškoti")').count()) > 0;
  if (hasNormalForm) return false;

  // Regitra challenge page has dedicated controls/text (answer box + submit + support ID text).
  const hasChallengeControls = (await page.locator('#ans, #jar, #captcha_audio').count()) > 0;
  const bodyText = (await page.innerText('body').catch(() => '')).toLowerCase();
  const hasChallengeText =
    (bodyText.includes('human visitor') && bodyText.includes('automated spam submission')) ||
    bodyText.includes('your support id is');

  return hasChallengeControls || hasChallengeText;
}

async function maybeWaitForManualChallengeSolve(page, stage) {
  if (!(await detectCaptchaLike(page))) return;
  if (!isTruthy(process.env.ALLOW_MANUAL_CHALLENGE)) {
    throw new Error(`Bot challenge detected ${stage} (captcha/human verification).`);
  }

  const timeoutMs = Number(process.env.MANUAL_CHALLENGE_TIMEOUT_MS || 180000);
  console.warn(`Bot challenge detected ${stage}. Waiting up to ${Math.floor(timeoutMs / 1000)}s for manual solve...`);
  await page.bringToFront().catch(() => null);

  await page
    .waitForFunction(
      () => {
        const text = document.body?.innerText?.toLowerCase() || '';
        const hasChallengeText =
          text.includes('human visitor') ||
          text.includes('automated spam submission') ||
          text.includes('captcha');
        const hasChallengeInput = Boolean(document.querySelector('#ans'));
        return !hasChallengeText && !hasChallengeInput;
      },
      { timeout: timeoutMs }
    )
    .catch(() => {
      throw new Error('Manual challenge was not solved in time.');
    });
}

async function sendTelegramMessage(text) {
  if (!telegramConfig.botToken || !telegramConfig.chatId) {
    console.warn('Telegram config missing; skipping Telegram notification.');
    return;
  }

  const response = await fetch(`https://api.telegram.org/bot${telegramConfig.botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: telegramConfig.chatId,
      text,
      disable_web_page_preview: true
    })
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok === false) {
    throw new Error(`Telegram send failed: ${payload.description || response.statusText}`);
  }
}

function formatTelegramMessage(result) {
  const s = result.statuses || {};
  return [
    'Regitra patikra',
    `Draudimas galioja: ${s.draudimasGalioja || 'NERASTA'}`,
    `Leidimas dalyvauti eisme: ${s.leidimasDalyvautiEisme || 'NERASTA'}`,
    `Technikine: ${s.technikine || 'NERASTA'}`,
    `Tikrinimo laikas: ${result.checkedAt || 'n/a'}`
  ].join('\n');
}

async function maybePauseAtResults(page) {
  const waitMs = Number(process.env.WAIT_AT_RESULTS_MS || 0);
  if (!waitMs) return;
  console.log(`Pausing on results page for ${Math.floor(waitMs / 1000)} seconds...`);
  await page.bringToFront().catch(() => null);
  await page.waitForTimeout(waitMs);
}

async function runAttempt(attemptNumber) {
  const launchOptions = {
    headless: !isTruthy(process.env.HEADFUL)
  };
  if (process.env.PLAYWRIGHT_CHANNEL) {
    launchOptions.channel = process.env.PLAYWRIGHT_CHANNEL;
  }
  const browser = await chromium.launch(launchOptions);

  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });

  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1366, height: 768 },
    locale: 'lt-LT',
    timezoneId: 'Europe/Vilnius'
  });

  const page = await context.newPage();

  try {
    await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await randomPause(400, 1100);

    await maybeWaitForManualChallengeSolve(page, 'before form load');

    const cookieButton = page.getByRole('button', {
      name: /Leisti visus slapukus|Leisti pasirinkti|Sutinku|Priimti|Accept/i
    }).first();
    if (await cookieButton.count()) {
      await cookieButton.click({ timeout: 5000 }).catch(() => null);
      await randomPause(300, 800);
    }

    await clickFirstAvailable(page, [
      'button:has-text("Sutinku")',
      'button:has-text("Priimti")',
      'button:has-text("Accept")',
      'button:has-text("Leisti visus slapukus")',
      'button:has-text("Leisti pasirinkti")'
    ]);
    await randomPause(300, 800);

    await Promise.race([
      page.locator('h1:has-text("Ieškoti informacijos")').first().waitFor({ state: 'visible', timeout: 12000 }),
      page.locator('input[type="text"]:visible').nth(1).waitFor({ state: 'visible', timeout: 12000 })
    ]).catch(() => null);

    await maybeWaitForManualChallengeSolve(page, 'before input fill');

    const filledCertById = await fillDirectById(
      page,
      'registrationNo',
      vehicleData.certNumber,
      'registration certificate number'
    );
    const filledCertByLabel = filledCertById || await fillByLabelCandidates(
      page,
      ['Registracijos liudijimo numeris', 'Registracijos dokumento numeris', 'Liudijimo numeris'],
      vehicleData.certNumber
    );
    if (!filledCertByLabel) {
      await fillFromCandidates(
        page,
        [
          'input[name*="cert" i]',
          'input[id*="cert" i]',
          'input[name*="dokument" i]',
          'input[id*="dokument" i]',
          'input[name*="liudij" i]',
          'input[id*="liudij" i]',
          'input[placeholder*="liudij" i]',
          'input[placeholder*="dokument" i]',
          'input[placeholder*="cert" i]'
        ],
        vehicleData.certNumber,
        'registration certificate number'
      );
    }

    await randomPause();
    const filledPlateById = await fillDirectById(
      page,
      'plateNo',
      vehicleData.plate,
      'plate number'
    );
    const filledPlateByLabel = filledPlateById || await fillByLabelCandidates(
      page,
      ['Valstybinis numeris', 'Valst. numeris', 'Automobilio numeris'],
      vehicleData.plate
    );
    if (!filledPlateByLabel) {
      const plateFilled = await clickFirstAvailable(page, [
        'input[name*="plate" i]',
        'input[id*="plate" i]',
        'input[name*="valst" i]',
        'input[id*="valst" i]',
        'input[placeholder*="valstybin" i]'
      ]);
      if (plateFilled) {
        const plateInput = page.locator(
          [
            'input[name*="plate" i]',
            'input[id*="plate" i]',
            'input[name*="valst" i]',
            'input[id*="valst" i]',
            'input[placeholder*="valstybin" i]'
          ].join(', ')
        ).first();
        await typeHuman(plateInput, vehicleData.plate);
      } else {
        await fillByVisibleTextInputIndex(page, 1, vehicleData.plate, 'plate number');
      }
    }

    if ((await page.locator('input[type="text"]:visible').count()) === 1) {
      // Fallback for layouts where both values share one visible field before reveal.
      const singleInput = page.locator('input[type="text"]:visible').first();
      const currentValue = await singleInput.inputValue();
      if (currentValue.trim() !== vehicleData.certNumber) {
        await typeHuman(singleInput, vehicleData.certNumber);
      }
    }

    await randomPause();

    await clickAllRequiredCheckboxes(page);

    await randomPause(350, 900);

    const clickedSubmit = await clickFirstAvailable(page, [
      'button:has-text("Ieškoti")',
      'button:has-text("Tikrinti")',
      'button[type="submit"]',
      'input[type="submit"]'
    ]);

    if (!clickedSubmit) {
      throw new Error('Submit button not found. Selectors likely need adjustment.');
    }

    await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => null);
    await randomPause(900, 1700);

    await maybeWaitForManualChallengeSolve(page, 'after submit');
    await maybePauseAtResults(page);

    const text = await page.innerText('body');
    fs.writeFileSync(PAGE_TEXT_PATH, text);

    const result = {
      checkedAt: new Date().toISOString(),
      attempt: attemptNumber,
      statuses: {
        draudimasGalioja: extractStatus(text, ['Draudimas galioja', 'Draudimas']),
        leidimasDalyvautiEisme: extractStatus(text, [
          'Leidimas dalyvauti eisme',
          'Dalyvavimas viešajame eisme',
          'Leidimas'
        ]),
        technikine: extractStatus(text, [
          'Techninė apžiūra',
          'Techninės apžiūra',
          'Techninės apžiūros',
          'Technikine'
        ])
      }
    };

    fs.writeFileSync(path.join(ARTIFACT_DIR, 'result.json'), JSON.stringify(result, null, 2));
    await page.screenshot({ path: SCREENSHOT_PATH, fullPage: true });

    const unresolved = Object.values(result.statuses).filter((v) => v === 'NERASTA').length;
    if (unresolved >= 2) {
      throw new Error('Result parsed, but key status fields were not found. Verify selectors/parsing against current page layout.');
    }

    return result;
  } catch (err) {
    await page.screenshot({ path: SCREENSHOT_PATH, fullPage: true }).catch(() => null);
    throw err;
  } finally {
    await context.close();
    await browser.close();
  }
}

async function main() {
  const maxAttempts = Number(process.env.MAX_ATTEMPTS || 3);
  let lastError;

  for (let i = 1; i <= maxAttempts; i += 1) {
    try {
      const result = await runAttempt(i);
      await sendTelegramMessage(formatTelegramMessage(result));
      console.log(JSON.stringify(result, null, 2));
      return;
    } catch (err) {
      lastError = err;
      console.error(`[attempt ${i}/${maxAttempts}] ${err.message}`);

      if (i < maxAttempts) {
        await sleep(5000 * i);
      }
    }
  }

  await sendTelegramMessage(
    [
      'Regitra patikra nepavyko',
      `Klaida: ${lastError.message}`,
      `Bandymu skaicius: ${maxAttempts}`
    ].join('\n')
  ).catch((err) => {
    console.error(`Failed to send Telegram failure notification: ${err.message}`);
  });

  console.error(`FAILED after ${maxAttempts} attempts: ${lastError.message}`);
  process.exit(1);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
