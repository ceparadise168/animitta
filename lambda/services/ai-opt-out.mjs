import { OrganizationsClient, DescribeEffectivePolicyCommand } from '@aws-sdk/client-organizations'

// Organizations has one global endpoint, in us-east-1, whatever region the
// function runs in.
const client = new OrganizationsClient({ region: 'us-east-1' })

/**
 * Why Amazon may keep what Transcribe hears to improve its AI services, or
 * null when it may not. 關於 tells users a recording is deleted once it is
 * transcribed, which holds only while this account's effective AI services
 * opt-out policy says optOut for Transcribe. Asked before every recording, so
 * a move between AWS organizations, a detached policy or a deploy to a new
 * account pauses voice instead of breaking the promise. Anything that is not
 * a clear optOut, including no answer, counts as a reason.
 */
export async function whyRecordingsMayBeKept() {
  try {
    const { EffectivePolicy } = await client.send(
      new DescribeEffectivePolicyCommand({ PolicyType: 'AISERVICES_OPT_OUT_POLICY' })
    )
    const services = JSON.parse(EffectivePolicy.PolicyContent).services ?? {}
    const setting = (services.transcribe ?? services.default)?.opt_out_policy
    return setting === 'optOut' ? null : `the effective AI services opt-out policy says ${setting ?? 'nothing'} for Transcribe`
  } catch (err) {
    if (err.name === 'AWSOrganizationsNotInUseException') return 'this AWS account is in no organization, so no AI services opt-out policy applies'
    if (err.name === 'EffectivePolicyNotFoundException') return 'no AI services opt-out policy applies to this account'
    return `the AI services opt-out could not be checked (${err.name})`
  }
}
