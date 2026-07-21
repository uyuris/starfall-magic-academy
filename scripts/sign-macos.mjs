import osxSign from '@electron/osx-sign';

const { signAsync } = osxSign;

export async function sign(options) {
  await signAsync({
    ...options,
    identity: '-',
    identityValidation: false,
    preAutoEntitlements: false,
  });
}

export default sign;
