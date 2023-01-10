import { Preference } from './prefs'
import { log } from './logger'

type Handler = () => void
type TimerHandle = ReturnType<typeof setTimeout>
type Job = {
  id: number
  start: number
  handler: Handler
  timer: TimerHandle
}

export class Scheduler {
  private _delay: string | number
  private factor: number
  private job: Map<number, Job> = new Map
  private held: Map<number, Handler> = null

  constructor(delay: string | number, factor = 1) {
    this._delay = delay
    this.factor = factor
  }

  public get delay(): number {
    return (typeof this._delay === 'string' ? Preference[this._delay] : this._delay) * this.factor
  }

  public get enabled(): boolean {
    return this.delay !== 0
  }

  public get paused(): boolean {
    return this.held !== null
  }

  public set paused(paused: boolean) {
    if (paused === this.paused) {
      log.debug('scheduler: already', paused ? 'paused' : 'active')
      return
    }

    if (paused) {
      log.debug('scheduler: pausing')
      this.held = new Map
    }
    else {
      log.debug('scheduler: resuming')
      const held = this.held
      this.held = null

      for (const [id, handler] of held.entries()) {
        log.debug('scheduler: resuming', id)
        this.schedule(id, handler)
      }
    }
  }

  public schedule(id: number, handler: Handler): void {
    log.debug('scheduler.schedule:', { id, held: !!this.held })
    if (this.held) {
      this.held.set(id, handler)
      return
    }

    let job: Job
    if (job = this.job.get(id)) {
      log.debug('scheduler: rescheduling', id, 'after', Date.now() - job.start)
      clearTimeout(job.timer)
    }
    else {
      log.debug('scheduler: scheduling', id)
      job = {
        id,
        start: Date.now(),
        handler,
        timer: 0 as unknown as TimerHandle,
      }
    }
    job.timer = setTimeout(j => {
      log.debug('scheduler: running', j.id, 'after', Date.now() - j.start)
      this.job.delete(id)
      j.handler()
    }, this.delay, job)
    this.job.set(id, job)
  }

  public cancel(id: number): void {
    let job: Job
    if (this.held) {
      this.held.delete(id)
    }
    else if (job = this.job.get(id)) {
      clearTimeout(job.timer)
      this.job.delete(id)
    }
  }
}
