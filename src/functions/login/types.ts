export interface SecurityIncident {
    kind: string
    account: string
    details?: string[]
    next?: string[]
    docsUrl?: string
}
