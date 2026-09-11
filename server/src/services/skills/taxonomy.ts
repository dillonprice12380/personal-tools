/**
 * Built-in starter taxonomy.
 *
 * This is Helm's own curation, not O*NET data, and it is labelled `starter` in
 * the database so the two never get confused. It exists so the module does
 * something useful on a fresh install without a 200MB download first, and it is
 * aimed at the person Helm is built for: someone running a small operation
 * alone, wearing every hat.
 *
 * The numbers are considered judgement, not survey results. For authoritative,
 * citable ratings across ~1,000 occupations, import the real thing:
 *
 *   npm run skills:import -- --dir ./db_30_0_text
 *
 * An O*NET import upserts by code, so it takes precedence over these rows
 * wherever the two describe the same element.
 */

export type StarterSkill = {
  code: string;
  name: string;
  category: string;
  description?: string;
  /** Extra words for course search - O*NET-style names are too abstract alone. */
  search_terms?: string;
};

export type StarterRole = {
  code: string;
  title: string;
  description: string;
  /** skill code -> [importance, required level], both 0-100. */
  requirements: Record<string, [number, number]>;
};

export const STARTER_SKILLS: StarterSkill[] = [
  // --- craft -------------------------------------------------------------
  { code: 'starter:web-frontend', name: 'Front-end development', category: 'Technology', search_terms: 'html css javascript react frontend' },
  { code: 'starter:web-backend', name: 'Back-end development', category: 'Technology', search_terms: 'node python api backend server' },
  { code: 'starter:databases', name: 'Databases & SQL', category: 'Technology', search_terms: 'sql postgres database design' },
  { code: 'starter:devops', name: 'Deployment & hosting', category: 'Technology', search_terms: 'devops docker ci cd hosting deployment' },
  { code: 'starter:security', name: 'Application security', category: 'Technology', search_terms: 'web application security owasp' },
  { code: 'starter:automation', name: 'Scripting & automation', category: 'Technology', search_terms: 'python automation scripting workflow' },
  { code: 'starter:data-analysis', name: 'Data analysis', category: 'Technology', search_terms: 'data analysis pandas excel statistics' },
  { code: 'starter:data-viz', name: 'Data visualisation', category: 'Technology', search_terms: 'data visualization dashboard charts' },
  { code: 'starter:ai-tooling', name: 'AI tooling & prompting', category: 'Technology', search_terms: 'ai llm prompt engineering api' },

  // --- marketing ---------------------------------------------------------
  { code: 'starter:seo', name: 'Search engine optimisation', category: 'Marketing', search_terms: 'seo search engine optimization' },
  { code: 'starter:content-strategy', name: 'Content strategy', category: 'Marketing', search_terms: 'content marketing strategy editorial' },
  { code: 'starter:copywriting', name: 'Copywriting', category: 'Marketing', search_terms: 'copywriting sales copy persuasive writing' },
  { code: 'starter:social-media', name: 'Social media marketing', category: 'Marketing', search_terms: 'social media marketing strategy' },
  { code: 'starter:email-marketing', name: 'Email marketing', category: 'Marketing', search_terms: 'email marketing newsletter automation' },
  { code: 'starter:paid-ads', name: 'Paid advertising', category: 'Marketing', search_terms: 'google ads facebook ads ppc' },
  { code: 'starter:analytics', name: 'Marketing analytics', category: 'Marketing', search_terms: 'google analytics attribution marketing metrics' },
  { code: 'starter:brand', name: 'Brand positioning', category: 'Marketing', search_terms: 'branding positioning messaging' },

  // --- creative ----------------------------------------------------------
  { code: 'starter:graphic-design', name: 'Graphic design', category: 'Creative', search_terms: 'graphic design figma photoshop' },
  { code: 'starter:ux', name: 'UX & interface design', category: 'Creative', search_terms: 'ux ui design usability figma' },
  { code: 'starter:video-production', name: 'Video production', category: 'Creative', search_terms: 'video production filmmaking premiere' },
  { code: 'starter:video-editing', name: 'Video editing', category: 'Creative', search_terms: 'video editing davinci resolve premiere' },
  { code: 'starter:audio', name: 'Audio & voiceover', category: 'Creative', search_terms: 'audio editing podcast voiceover audition' },
  { code: 'starter:photography', name: 'Photography', category: 'Creative', search_terms: 'photography lighting composition' },

  // --- business ----------------------------------------------------------
  { code: 'starter:sales', name: 'Sales & closing', category: 'Business', search_terms: 'sales closing b2b selling' },
  { code: 'starter:negotiation', name: 'Negotiation', category: 'Business', search_terms: 'negotiation skills deal making' },
  { code: 'starter:client-management', name: 'Client management', category: 'Business', search_terms: 'client management account management consulting' },
  { code: 'starter:pricing', name: 'Pricing & packaging', category: 'Business', search_terms: 'pricing strategy value based pricing' },
  { code: 'starter:proposals', name: 'Proposals & scoping', category: 'Business', search_terms: 'proposal writing statement of work scoping' },
  { code: 'starter:bookkeeping', name: 'Bookkeeping', category: 'Business', search_terms: 'bookkeeping accounting quickbooks' },
  { code: 'starter:financial-modelling', name: 'Financial modelling', category: 'Business', search_terms: 'financial modeling forecasting excel' },
  { code: 'starter:tax-compliance', name: 'Tax & compliance', category: 'Business', search_terms: 'small business tax self employed compliance' },
  { code: 'starter:contracts', name: 'Contracts & legal basics', category: 'Business', search_terms: 'freelance contracts business law basics' },

  // --- operating ---------------------------------------------------------
  { code: 'starter:project-management', name: 'Project management', category: 'Operating', search_terms: 'project management agile planning' },
  { code: 'starter:time-management', name: 'Time & priority management', category: 'Operating', search_terms: 'time management productivity prioritisation' },
  { code: 'starter:process-design', name: 'Process design & SOPs', category: 'Operating', search_terms: 'business process sop documentation' },
  { code: 'starter:delegation', name: 'Delegation & hiring', category: 'Operating', search_terms: 'hiring delegation outsourcing freelancers' },
  { code: 'starter:customer-support', name: 'Customer support', category: 'Operating', search_terms: 'customer support service helpdesk' },

  // --- cross-cutting -----------------------------------------------------
  { code: 'starter:writing', name: 'Written communication', category: 'Core', search_terms: 'business writing communication clarity' },
  { code: 'starter:speaking', name: 'Speaking & presenting', category: 'Core', search_terms: 'public speaking presentation skills' },
  { code: 'starter:research', name: 'Research & synthesis', category: 'Core', search_terms: 'research skills critical thinking synthesis' },
  { code: 'starter:problem-solving', name: 'Problem solving', category: 'Core', search_terms: 'problem solving critical thinking' },
  { code: 'starter:systems-thinking', name: 'Systems thinking', category: 'Core', search_terms: 'systems thinking business analysis' },
  { code: 'starter:teaching', name: 'Teaching & explaining', category: 'Core', search_terms: 'instructional design teaching course creation' },
];

export const STARTER_ROLES: StarterRole[] = [
  {
    code: 'helm:freelance-web-developer',
    title: 'Freelance web developer',
    description:
      'Builds and ships sites and applications for clients, and runs the business around that work alone.',
    requirements: {
      'starter:web-frontend': [95, 80],
      'starter:web-backend': [85, 70],
      'starter:databases': [75, 60],
      'starter:devops': [70, 60],
      'starter:security': [65, 50],
      'starter:ux': [60, 50],
      'starter:automation': [50, 40],
      'starter:client-management': [85, 70],
      'starter:proposals': [75, 60],
      'starter:pricing': [70, 60],
      'starter:contracts': [60, 40],
      'starter:project-management': [70, 60],
      'starter:time-management': [75, 60],
      'starter:writing': [70, 60],
      'starter:problem-solving': [90, 80],
      'starter:sales': [65, 50],
      'starter:bookkeeping': [45, 40],
    },
  },
  {
    code: 'helm:digital-marketing-consultant',
    title: 'Digital marketing consultant',
    description:
      'Plans and runs acquisition for clients across search, content, social and paid, and reports on what it returned.',
    requirements: {
      'starter:seo': [90, 80],
      'starter:content-strategy': [85, 75],
      'starter:copywriting': [85, 75],
      'starter:analytics': [85, 70],
      'starter:paid-ads': [75, 60],
      'starter:social-media': [75, 60],
      'starter:email-marketing': [70, 60],
      'starter:brand': [65, 55],
      'starter:data-analysis': [60, 50],
      'starter:client-management': [85, 70],
      'starter:proposals': [75, 60],
      'starter:pricing': [65, 55],
      'starter:speaking': [65, 55],
      'starter:writing': [85, 75],
      'starter:research': [70, 60],
      'starter:project-management': [65, 55],
    },
  },
  {
    code: 'helm:content-creator',
    title: 'Content creator / video producer',
    description:
      'Makes video and written content at a steady cadence, distributes it, and earns from audience, sponsorship or product.',
    requirements: {
      'starter:video-production': [90, 75],
      'starter:video-editing': [90, 80],
      'starter:audio': [75, 60],
      'starter:copywriting': [80, 70],
      'starter:content-strategy': [85, 70],
      'starter:social-media': [85, 70],
      'starter:seo': [70, 55],
      'starter:graphic-design': [65, 50],
      'starter:photography': [55, 40],
      'starter:speaking': [80, 70],
      'starter:analytics': [65, 50],
      'starter:brand': [75, 60],
      'starter:time-management': [80, 65],
      'starter:pricing': [55, 45],
      'starter:teaching': [60, 50],
    },
  },
  {
    code: 'helm:data-analyst',
    title: 'Data analyst',
    description:
      'Turns raw operational data into decisions - pulls it, cleans it, models it and presents what it means.',
    requirements: {
      'starter:data-analysis': [95, 85],
      'starter:databases': [90, 80],
      'starter:data-viz': [85, 75],
      'starter:automation': [70, 60],
      'starter:research': [75, 65],
      'starter:problem-solving': [90, 80],
      'starter:systems-thinking': [75, 65],
      'starter:writing': [80, 70],
      'starter:speaking': [70, 60],
      'starter:financial-modelling': [60, 50],
      'starter:ai-tooling': [55, 45],
      'starter:project-management': [55, 45],
    },
  },
  {
    code: 'helm:solo-saas-founder',
    title: 'Solo SaaS founder',
    description:
      'Designs, builds, sells and supports a software product without a team behind any of those.',
    requirements: {
      'starter:web-frontend': [85, 70],
      'starter:web-backend': [90, 75],
      'starter:databases': [80, 70],
      'starter:devops': [80, 65],
      'starter:security': [75, 60],
      'starter:ux': [75, 60],
      'starter:copywriting': [80, 65],
      'starter:seo': [70, 55],
      'starter:content-strategy': [70, 55],
      'starter:pricing': [85, 70],
      'starter:sales': [70, 55],
      'starter:customer-support': [75, 60],
      'starter:analytics': [70, 60],
      'starter:financial-modelling': [65, 50],
      'starter:time-management': [85, 70],
      'starter:process-design': [65, 55],
      'starter:ai-tooling': [65, 50],
    },
  },
  {
    code: 'helm:agency-owner',
    title: 'Small agency owner',
    description:
      'Sells the work, delegates the delivery, and is accountable for margin, cashflow and everyone on the roster.',
    requirements: {
      'starter:sales': [90, 80],
      'starter:negotiation': [85, 70],
      'starter:client-management': [90, 80],
      'starter:pricing': [90, 80],
      'starter:proposals': [85, 70],
      'starter:delegation': [90, 75],
      'starter:process-design': [80, 70],
      'starter:project-management': [85, 75],
      'starter:bookkeeping': [70, 60],
      'starter:financial-modelling': [75, 65],
      'starter:tax-compliance': [65, 50],
      'starter:contracts': [75, 60],
      'starter:brand': [75, 60],
      'starter:speaking': [75, 65],
      'starter:writing': [80, 70],
      'starter:systems-thinking': [80, 70],
    },
  },
];
