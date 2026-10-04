import { z } from 'zod'

export const accountTypeSchema = z.enum(['Connected', 'Derived', 'Imported', 'Watched'])
