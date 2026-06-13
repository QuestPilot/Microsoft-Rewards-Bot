export interface CorePromoBannerConfig {
    dashboardHost: string
    dashboardPath: string
    imageUrl: string
    imageAlt: string
    sourcePatterns: string[]
    cardTextPatterns: string[]
    cardLinkPatterns: string[]
}

export const CORE_PROMO_BANNER_IMAGE_URL =
    'https://raw.githubusercontent.com/QuestPilot/Microsoft-Rewards-Bot/main/assets/banner-core.png'

export const CORE_PROMO_BANNER_RUNTIME_CONFIG: CorePromoBannerConfig = {
    dashboardHost: 'rewards.bing.com',
    dashboardPath: '/dashboard',
    imageUrl: CORE_PROMO_BANNER_IMAGE_URL,
    imageAlt: 'QuestPilot Core plugin banner',
    sourcePatterns: ['EdgeSearch_Dashboard', '/membercenter/missions/Animated-Banners/', 'search bar'],
    cardTextPatterns: ['search bar', '100 points'],
    cardLinkPatterns: ['microsoft-edge://?ux=searchbar', 'pc=esb']
}

export function installCorePromoBanner(config: CorePromoBannerConfig): void {
    if (typeof window === 'undefined' || typeof document === 'undefined') return
    if (window.location.hostname !== config.dashboardHost || window.location.pathname !== config.dashboardPath) return

    const includesAny = (value: string, patterns: string[]): boolean => {
        const haystack = value.toLowerCase()
        return patterns.some(pattern => haystack.includes(pattern.toLowerCase()))
    }

    const closestRewardCard = (element: Element): HTMLElement | null => {
        let current: Element | null = element
        for (let depth = 0; current && depth < 8; depth++) {
            if (current instanceof HTMLElement) {
                const text = current.textContent ?? ''
                const links = Array.from(current.querySelectorAll<HTMLAnchorElement>('a[href]'))
                    .map(link => link.href)
                    .join(' ')

                if (includesAny(text, config.cardTextPatterns) || includesAny(links, config.cardLinkPatterns)) {
                    return current
                }
            }
            current = current.parentElement
        }

        return null
    }

    const matchesImageSource = (image: HTMLImageElement): boolean => {
        return includesAny(
            [
                image.currentSrc,
                image.src,
                image.getAttribute('src') ?? '',
                image.getAttribute('srcset') ?? '',
                image.getAttribute('alt') ?? ''
            ].join(' '),
            config.sourcePatterns
        )
    }

    const findPromoImage = (): HTMLImageElement | null => {
        const images = Array.from(document.querySelectorAll<HTMLImageElement>('img'))

        for (const image of images) {
            if (matchesImageSource(image)) return image
        }

        for (const link of Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href]'))) {
            if (!includesAny(link.href, config.cardLinkPatterns)) continue
            const card = closestRewardCard(link)
            const image = card?.querySelector<HTMLImageElement>('img')
            if (image) return image
        }

        for (const image of images) {
            const card = closestRewardCard(image)
            if (card?.querySelector('a[href*="microsoft-edge://"], a[href*="pc=esb"]')) return image
        }

        return null
    }

    const applyBanner = (): void => {
        const image = findPromoImage()
        if (!image) return

        if (image.src !== config.imageUrl) image.src = config.imageUrl
        if (image.getAttribute('srcset')) image.removeAttribute('srcset')
        image.alt = config.imageAlt
        image.loading = 'eager'
        image.decoding = 'async'
        image.dataset.questpilotCoreBanner = 'true'
    }

    const scheduleApply = (): void => {
        window.requestAnimationFrame(applyBanner)
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', scheduleApply, { once: true })
    } else {
        scheduleApply()
    }

    const root = document.documentElement
    if (!root) return

    const observer = new MutationObserver(scheduleApply)
    observer.observe(root, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ['src', 'srcset', 'alt']
    })
}
