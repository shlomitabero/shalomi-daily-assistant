// The honest registry of revenue sources. Each one is either fully wired to
// a real connector (requiredEnv all present) or explicitly "not connected"
// with a plain-language instruction for how to connect it — never silently
// pretending to scan something there's no real access to.
export const SOURCE_DEFINITIONS = [
  {
    id: 'ai_digital_products',
    name: 'מוצרים דיגיטליים מבוססי AI',
    category: 'digital_products',
    description: 'יצירת מוצר דיגיטלי (מדריך, תבנית, כלי עבודה) בעזרת AI ומכירתו דרך דף תשלום אמיתי. זהו מסלול ההכנסה הראשון שמומש מקצה לקצה.',
    requiredEnv: ['ANTHROPIC_API_KEY', 'PADDLE_API_KEY', 'PADDLE_CLIENT_TOKEN', 'PADDLE_WEBHOOK_SECRET'],
    howToConnect: 'הגדר את ANTHROPIC_API_KEY (console.anthropic.com) ואת שלושת משתני ה-Paddle (vendors.paddle.com → Authentication + Notifications) כמשתני סביבה בשרת.',
  },
  {
    id: 'financial_markets',
    name: 'שווקים פיננסיים — מעקב וסימולציה',
    category: 'financial',
    description: 'מעקב אחרי מחירי שוק אמיתיים וסימולציית מסחר (עם עמלות והחלקת מחיר). מסחר בכסף אמיתי דורש חיבור ברוקר נפרד שלא קיים כאן, ולא יופעל בלעדיו.',
    requiredEnv: ['MARKET_DATA_API_KEY'],
    howToConnect: 'הירשם לשירות נתוני שוק עם תוכנית חינמית (לדוגמה twelvedata.com) והגדר MARKET_DATA_API_KEY כמשתנה סביבה.',
  },
  {
    id: 'affiliate_programs',
    name: 'שיווק שותפים ותוכניות תגמול',
    category: 'affiliate',
    description: 'מעקב אחרי ביצועים בתוכניות שיווק שותפים שהצטרפת אליהן.',
    requiredEnv: ['AFFILIATE_API_KEY'],
    howToConnect: 'עדיין לא נבנה חיבור ספציפי. ספר לי לאיזו תוכנית שיווק שותפים (ולאיזה API שלה) להתחבר, ואוסיף את החיבור.',
  },
  {
    id: 'supplier_price_gaps',
    name: 'פערי מחירים בין ספקים',
    category: 'arbitrage',
    description: 'השוואת מחירים בין ספקים ופלטפורמות שונות כדי לאתר פערי רווח אפשריים.',
    requiredEnv: ['SUPPLIER_API_KEY'],
    howToConnect: 'עדיין לא נבנה חיבור ספציפי. ספר לי לאיזה ספקים/פלטפורמות להתחבר ואוסיף את החיבור.',
  },
  {
    id: 'tenders_rfps',
    name: 'מכרזים ובקשות הצעות מחיר',
    category: 'tenders',
    description: 'סריקת מכרזים ציבוריים או עסקיים רלוונטיים לתחומי העניין שהגדרת.',
    requiredEnv: ['TENDERS_API_KEY'],
    howToConnect: 'עדיין לא נבנה חיבור ספציפי. ספר לי לאיזו מערכת מכרזים (לדוגמה מערכת המכרזים הממשלתית) להתחבר ואוסיף את החיבור.',
  },
];

export function isSourceConnected(definition, env = process.env) {
  return definition.requiredEnv.every((key) => Boolean(env[key]));
}
