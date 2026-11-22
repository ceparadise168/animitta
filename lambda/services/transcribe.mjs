import { randomUUID } from 'node:crypto'
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectsCommand } from '@aws-sdk/client-s3'
import {
  TranscribeClient,
  StartTranscriptionJobCommand,
  GetTranscriptionJobCommand,
  DeleteTranscriptionJobCommand,
} from '@aws-sdk/client-transcribe'

const s3 = new S3Client()
const transcribeClient = new TranscribeClient()
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
// Jobs measured in Tokyo took 8 to 21 seconds, for 12 seconds to 3.5 minutes of
// audio. With less time than this left, a job would be paid for and then given
// up on, so none is started.
const LEAST_TIME_FOR_A_JOB_MS = 15_000

/**
 * Turn a voice message into Taiwanese Mandarin text with Amazon Transcribe.
 * The recording and the transcript sit in VOICE_BUCKET_NAME only while the
 * job runs and are deleted before this returns, whether it worked or not.
 * One gap: Transcribe refuses to delete or stop a job still in progress, so a
 * job that outruns the deadline writes its transcript after this cleanup. The
 * bucket's expiry rule removes that one, and anything else a delete missed.
 * Throws if the job fails or is not done by the deadline (a Date.now() value).
 *
 * onJobStart runs just before the job is asked for: from then on, Amazon may
 * bill the audio. Two status checks a second keep each message well inside
 * Transcribe's 30 GetTranscriptionJob calls a second for the account.
 */
export async function transcribe(audio, { deadline, pollMs = 500, onJobStart }) {
  if (Date.now() > deadline - LEAST_TIME_FOR_A_JOB_MS) throw new Error('Too little time left to transcribe before the deadline')
  const bucket = process.env.VOICE_BUCKET_NAME
  const id = randomUUID()
  const jobName = `animitta-${id}`
  const audioKey = `audio/${id}.m4a`
  const transcriptKey = `transcripts/${id}.json`
  let jobStarted = false

  try {
    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: audioKey, Body: audio }))
    onJobStart?.()
    await transcribeClient.send(
      new StartTranscriptionJobCommand({
        TranscriptionJobName: jobName,
        LanguageCode: 'zh-TW',
        Media: { MediaFileUri: `s3://${bucket}/${audioKey}` },
        OutputBucketName: bucket,
        OutputKey: transcriptKey,
      })
    )
    jobStarted = true

    for (;;) {
      const { TranscriptionJob: job } = await transcribeClient.send(
        new GetTranscriptionJobCommand({ TranscriptionJobName: jobName })
      )
      if (job.TranscriptionJobStatus === 'COMPLETED') break
      if (job.TranscriptionJobStatus === 'FAILED') throw new Error(`Transcription failed: ${job.FailureReason}`)
      if (Date.now() >= deadline) throw new Error('Transcription was not done by the deadline')
      await sleep(pollMs)
    }

    const { Body } = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: transcriptKey }))
    const result = JSON.parse(await Body.transformToString())
    return result.results.transcripts.map((t) => t.transcript).join('').trim()
  } finally {
    await Promise.all([
      s3
        .send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: [{ Key: audioKey }, { Key: transcriptKey }] } }))
        .then((res) => {
          if (res.Errors?.length) console.warn(`Voice files left for the bucket to expire: ${res.Errors.length}`)
        })
        .catch((err) => console.warn(`Voice files left for the bucket to expire: ${err.name}`)),
      jobStarted &&
        transcribeClient
          .send(new DeleteTranscriptionJobCommand({ TranscriptionJobName: jobName }))
          .catch((err) => console.warn(`Transcription job not deleted: ${err.name}`)),
    ])
  }
}
