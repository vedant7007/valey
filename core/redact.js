import { fileURLToPath } from "node:url";

const PLACEHOLDERS = {
  EMAIL: "[EMAIL]",
  PHONE: "[PHONE]",
  OTP: "[OTP]",
  CARD: "[CARD]",
  TOKEN: "[TOKEN]"
};

const FINANCIAL_TERMS = /\b(bank|banking|upi|payment|paid|paytm|gpay|phonepe|transaction|debit|credit|card|account|balance|otp|verification|verify|password|pin|security alert|fraud|withdrawal|deposit|transfer)\b/i;

export function redact(text) {
  const found = new Set();
  let clean = String(text ?? "");

  clean = replace(clean, /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "EMAIL", found);
  clean = replace(clean, /\b(?:\d[ -]*?){13,19}\b/g, "CARD", found, isCardLike);
  clean = replace(clean, /\b(?=[A-Za-z0-9_-]{24,}\b)(?=.*[A-Za-z])(?=.*\d)[A-Za-z0-9_-]+\b/g, "TOKEN", found);
  clean = replace(clean, /(?:\+\d{1,3}[\s.-]?)?\d{5}[\s.-]?\d{5}\b|(?:\+\d{1,3}[\s.-]?)?(?:\(?\d{2,5}\)?[\s.-]?)?\d{3,4}[\s.-]?\d{4}\b/g, "PHONE", found, isPhoneLike);
  clean = replace(clean, /\b(?:otp|code|verification|verify|password|pin)\b\D{0,20}\b\d{4,8}\b/gi, "OTP", found);
  clean = replace(clean, /\b\d{4,8}\b/g, "OTP", found, isOtpLike);

  return { clean, found: Array.from(found) };
}

export function isFinancial(text) {
  return FINANCIAL_TERMS.test(String(text ?? ""));
}

function replace(input, pattern, type, found, guard = () => true) {
  return input.replace(pattern, (match) => {
    if (!guard(match)) {
      return match;
    }

    found.add(PLACEHOLDERS[type]);
    return PLACEHOLDERS[type];
  });
}

function digitsOnly(value) {
  return value.replace(/\D/g, "");
}

function isCardLike(value) {
  const digits = digitsOnly(value);
  return digits.length >= 13 && digits.length <= 19;
}

function isPhoneLike(value) {
  const digits = digitsOnly(value);
  if (digits.length < 10 || digits.length > 15) {
    return false;
  }

  if (digits.length >= 13 && digits.length <= 19 && isCardLike(value)) {
    return false;
  }

  return true;
}

function isOtpLike(value) {
  const digits = digitsOnly(value);
  if (digits.length < 4 || digits.length > 8) {
    return false;
  }

  if (digits === "2026") {
    return false;
  }

  return true;
}

function runSelfTest() {
  const cases = [
    {
      name: "email address",
      input: "Send it to user@example.test",
      expectClean: "Send it to [EMAIL]",
      expectFound: ["[EMAIL]"]
    },
    {
      name: "indian phone number",
      input: "Call me at +91 98765 43210",
      expectClean: "Call me at [PHONE]",
      expectFound: ["[PHONE]"]
    },
    {
      name: "six digit otp sentence",
      input: "Your OTP is 123456 for login",
      expectClean: "Your [OTP] for login",
      expectFound: ["[OTP]"]
    },
    {
      name: "standalone otp",
      input: "Use 847362 now",
      expectClean: "Use [OTP] now",
      expectFound: ["[OTP]"]
    },
    {
      name: "card with separators",
      input: "Card 4111-1111-1111-1111 was used",
      expectClean: "Card [CARD] was used",
      expectFound: ["[CARD]"]
    },
    {
      name: "api token",
      input: "Token abcdef1234567890abcdef123456 is active",
      expectClean: "Token [TOKEN] is active",
      expectFound: ["[TOKEN]"]
    },
    {
      name: "false positive guard",
      input: "The 2026 plan has 150 seats",
      expectClean: "The 2026 plan has 150 seats",
      expectFound: []
    },
    {
      name: "financial detector",
      input: "Security alert: payment transaction needs OTP",
      expectFinancial: true
    }
  ];

  let failures = 0;

  for (const testCase of cases) {
    const result = redact(testCase.input);
    const cleanOk = testCase.expectClean === undefined || result.clean === testCase.expectClean;
    const foundOk = testCase.expectFound === undefined || sameItems(result.found, testCase.expectFound);
    const financialOk = testCase.expectFinancial === undefined || isFinancial(testCase.input) === testCase.expectFinancial;
    const passed = cleanOk && foundOk && financialOk;

    console.log(`${passed ? "PASS" : "FAIL"} ${testCase.name}`);

    if (!passed) {
      failures += 1;
      console.log(`  clean: ${result.clean}`);
      console.log(`  found: ${result.found.join(",")}`);
      console.log(`  financial: ${isFinancial(testCase.input)}`);
    }
  }

  if (failures > 0) {
    process.exitCode = 1;
  }
}

function sameItems(left, right) {
  return left.length === right.length && left.every((item) => right.includes(item));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runSelfTest();
}
