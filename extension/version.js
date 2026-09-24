// Verze, ze které je tento build. prepare-source.sh sem dosadí LW_VERSION,
// MANTIS_RELEASE a MANTIS_RELEASE_PUBKEY ze scripts/config.sh; mimo build zůstanou
// zástupné texty.
const MANTIS_LW_VERSION = "@LW_VERSION@";
const MANTIS_RELEASE = "@MANTIS_RELEASE@";
// Veřejný klíč Ed25519 (base64), kterým je podepsaný latest.json; prázdný = neověřovat
const MANTIS_RELEASE_PUBKEY = "@RELEASE_PUBKEY@";
