/* The public half of the key the Apps2Samsung catalog workflow signs resolved.json with (#881).
 * The private half is the CATALOG_SIGNING_KEY secret of Apps2Samsung/Apps2Samsung. Replacing the
 * key means a TV-Store release: every TV keeps trusting this one until it updates.
 */
'use strict';
module.exports = [
    '-----BEGIN PUBLIC KEY-----',
    'MIIBojANBgkqhkiG9w0BAQEFAAOCAY8AMIIBigKCAYEAuSxPAaQONXHVJJ2gsndQ',
    'IHyTpG1CZP9lScSqCXFQad0h+m5xFtQ03mKGk67am7X5P7+SzOSPEBp+XIFjVOEe',
    'EfeLtm/+kX4M96CpgjtZLiuKa2EYd/1OFt9+ZYFaVUaJlprpQieLLFXpeENiG6MX',
    'AVbB8UCMkIGJz+eigeIkYU7HYO+9+HUS9oTvqeKoXZVUnDSNHYTCVWmzprIbXgLO',
    'va/bsHLXhGBl3IeNbfkC1nsHZjbcNxSFw6E+DLWv+2uZGM2Avx9vgYrMjgmbIyXc',
    'spu4wGJBs4p33lKCFltwXSuDrN8KBiLluK9pjXYLaOgzUhrKN0yzdAZewhXDD5tK',
    'zBUROgMjMDa+gc4CE0zmEfcbZ/mQU1FNt+y/TVig4tt86x7UoOyW+mLub58tOC/b',
    'eLANPPgLtNE+IOKOaaY3Y/4u9epiwPbYZR6lXo2T5NvDQjwSrOQ9l+I8imhrhupy',
    'bY4CTb76QMVny2rt5cQXnHasIhZkf6oi5m8KrePWCGVHAgMBAAE=',
    '-----END PUBLIC KEY-----',
].join('\n') + '\n';
