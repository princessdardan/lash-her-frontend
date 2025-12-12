import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function getStrapiURL(path: string = "") {
  return `${process.env.NEXT_PUBLIC_STRAPI_URL || "http://localhost:1337"}${path}`
}

/**
 * Fetch data from Strapi API with error handling
 * @param path - API endpoint path (e.g., '/api/home-page')
 * @param params - URLSearchParams or query string parameters
 * @param options - Additional fetch options
 * @returns Parsed JSON response or throws an error
 */
export async function fetchStrapi<T>(
  path: string,
  params?: URLSearchParams | Record<string, string>,
  options?: RequestInit
): Promise<T> {
  const fetchOptions: RequestInit = options || {}
  const url = new URL(path, getStrapiURL())
  
  // Add query parameters if provided
  if (params) {
    const searchParams = params instanceof URLSearchParams 
      ? params 
      : new URLSearchParams(params)
    url.search = searchParams.toString()
  }

  try {
    const response = await fetch(url.toString(), {
      ...fetchOptions,
      headers: {
        'Content-Type': 'application/json',
        ...fetchOptions.headers,
      },
      next: { revalidate: 60 }, // Cache for 60 seconds by default
    })

    if (!response.ok) {
      throw new Error(`Strapi API error: ${response.status} ${response.statusText}`)
    }

    return await response.json()
  } catch (error) {
    console.error(`Failed to fetch from Strapi: ${path}`, error)
    throw error
  }
}
